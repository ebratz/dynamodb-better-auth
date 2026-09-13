import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dynamodbAdapter } from '../src/adapter/factory.ts';
import { updateMethod } from '../src/adapter/methods/update.ts';
import { consumeOneMethod } from '../src/adapter/methods/consume-one.ts';
import { findManyMethod } from '../src/adapter/methods/find-many.ts';
import { findOneMethod } from '../src/adapter/methods/find-one.ts';
import { resolveQueryPlan } from '../src/helpers/query-planner.ts';
import { resolveKEYS_ONLY } from '../src/helpers/batch-get.ts';
import { createTransactionWrapper } from '../src/adapter/transaction.ts';

// Real adapter/factory/Better Auth code; only the DynamoDB network boundary
// is replaced. These are contract checks, not a DynamoDB service emulator.
const require = createRequire(import.meta.url);
const tables = { user: 'audit-users', session: 'audit-sessions', account: 'audit-accounts', verification: 'audit-verifications', emailLookups: 'audit-emails' };
const eq = (field, value) => ({ field, value, operator: 'eq' });
const row = { id: 'v1', identifier: 'audit-code', value: 'secret', expiresAt: '2000-01-01T00:00:00.000Z', createdAt: '1999-01-01T00:00:00.000Z', updatedAt: '1999-01-01T00:00:00.000Z' };
const user = { id: 'u1', email: 'old@example.test', name: 'Before', emailVerified: false, createdAt: row.createdAt, updatedAt: row.updatedAt };
function setup(handler, extra = {}, options = {}) {
  const client = { translateConfig: {}, send: vi.fn(handler) };
  const config = { client, tables, ...extra };
  return { client, config, adapter: dynamodbAdapter(config)(options) };
}
const reads = (item) => async (cmd) => {
  if (cmd.constructor.name === 'GetCommand') return { Item: { ...item } };
  if (['QueryCommand', 'ScanCommand'].includes(cmd.constructor.name)) return { Items: [{ ...item }] };
  return {};
};

test('F01: Better Auth rejects an expired database verification on consume', async () => {
  const { adapter } = setup(reads(row), { indexes: { verification: { identifier: { indexName: 'by-identifier', hashKey: 'identifier' } } } });
  const modulePath = require.resolve('better-auth').replace(/index\.mjs$/, 'db/internal-adapter.mjs');
  const { createInternalAdapter } = await import(pathToFileURL(modulePath).href);
  // Control: the ordinary factory path hydrates the identical stored row.
  const normalRead = await adapter.findOne({ model: 'verification', where: [eq('id', row.id)] });
  expect(normalRead.expiresAt).toBeInstanceOf(Date);
  expect(normalRead.expiresAt.getTime()).toBeLessThan(Date.now());
  const internal = createInternalAdapter(adapter, { options: {}, hooks: [], logger: { debug() {}, warn() {}, error() {} } });
  expect(await internal.consumeVerificationValue('audit-code')).toBeNull();
});

test('F02: tx.delete honors a false additional predicate even when PK is supplied', async () => {
  const { adapter, client } = setup(reads(user));
  await adapter.transaction((tx) => tx.delete({ model: 'user', where: [eq('id', 'u1'), eq('email', 'someone-else@example.test')] }));
  const mutations = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'TransactWriteCommand');
  expect(mutations).toHaveLength(0);
});

test('F03: update compare-and-set permits only one of two concurrent writers', async () => {
  let current = { id: 'u1', name: 'Before' };
  const client = { send: vi.fn(async (cmd) => {
    if (cmd.constructor.name === 'GetCommand') return { Item: { ...current } };
    if (cmd.constructor.name === 'UpdateCommand') {
      // Faithfully implement the condition currently emitted by the adapter.
      for (const match of cmd.input.ConditionExpression.matchAll(/(#c\d+) = (:c\d+)/g)) {
        const currentRow = typeof count === 'number' ? { ...user, count } : current;
        if (currentRow[cmd.input.ExpressionAttributeNames[match[1]]] !== cmd.input.ExpressionAttributeValues[match[2]]) {
          throw Object.assign(new Error('Predicate changed'), { name: 'ConditionalCheckFailedException' });
        }
      }
      current = { ...current, name: cmd.input.ExpressionAttributeValues[':v0'] };
      return { Attributes: { ...current } };
    }
    throw new Error('Unexpected command');
  }) };
  const update = updateMethod(client, { client, tables });
  const results = await Promise.all(['A', 'B'].map((name) => update({ model: 'user', where: [eq('id', 'u1'), eq('name', 'Before')], update: { name } })));
  expect(results.filter(Boolean)).toHaveLength(1);
});

test('F04: email uniqueness is maintained by ordinary adapter.update', async () => {
  const { adapter, client } = setup(async (cmd) => cmd.constructor.name === 'UpdateCommand' ? { Attributes: { ...user, email: 'new@example.test' } } : reads(user)(cmd), { enableEmailUniqueness: true });
  await adapter.update({ model: 'user', where: [eq('id', user.id)], update: { email: 'new@example.test' } });
  expect(client.send.mock.calls.some(([cmd]) => cmd.constructor.name === 'TransactWriteCommand')).toBe(true);
});

test('F04: ordinary adapter.delete releases the email claim', async () => {
  const { adapter, client } = setup(reads(user), { enableEmailUniqueness: true });
  await adapter.delete({ model: 'user', where: [eq('id', user.id)] });
  expect(client.send.mock.calls.some(([cmd]) => cmd.constructor.name === 'TransactWriteCommand')).toBe(true);
});

test('F05: unchanged email is a valid transactional update', async () => {
  const { adapter } = setup(reads(user), { enableEmailUniqueness: true });
  await expect(adapter.transaction((tx) => tx.update({ model: 'user', where: [eq('id', user.id)], update: { email: user.email } }))).resolves.toMatchObject({ email: user.email });
});

test('F06: GSI key fields never appear in Query FilterExpression', () => {
  const plan = resolveQueryPlan([eq('email', 'a@example.test'), { field: 'email', operator: 'ne', value: 'b@example.test' }], 'user', { tables, indexes: { user: { email: { indexName: 'by-email', hashKey: 'email' } } } });
  const illegal = Object.entries(plan.expressionAttributeNames).some(([alias, field]) => field === 'email' && plan.filterExpression?.includes(alias));
  expect(illegal).toBe(false);
});

test('F07: sparse-index sort loads the sort field before choosing the first row', async () => {
  const rows = [{ id: 'u1', email: 'group', name: 'Zoe' }, { id: 'u2', email: 'group', name: 'Amy' }];
  const client = { send: vi.fn(async (cmd) => {
    if (cmd.constructor.name === 'QueryCommand') return { Items: rows.map(({ id, email }) => ({ id, email })) };
    if (cmd.constructor.name === 'BatchGetCommand') return { Responses: { [tables.user]: cmd.input.RequestItems[tables.user].Keys.map(({ id }) => rows.find((r) => r.id === id)) } };
    throw new Error('Unexpected command');
  }) };
  const config = { client, tables, indexes: { user: { email: { indexName: 'by-email', hashKey: 'email', projection: 'KEYS_ONLY' } } } };
  const result = await findManyMethod(client, config)({ model: 'user', where: [eq('email', 'group')], sortBy: { field: 'name', direction: 'asc' }, limit: 1 });
  expect(result[0].name).toBe('Amy');
});

test('F07: BatchGet hydration preserves the ordered query result', async () => {
  const client = { send: vi.fn(async () => ({ Responses: { [tables.user]: [{ id: 'u2' }, { id: 'u1' }] } })) };
  const result = await resolveKEYS_ONLY(client, tables.user, { pkField: 'id' }, [{ id: 'u1' }, { id: 'u2' }]);
  expect(result.map((r) => r.id)).toEqual(['u1', 'u2']);
});

test('F08: tx.deleteMany after tx.update actually removes that row', async () => {
  const { adapter, client } = setup(reads(user));
  await adapter.transaction(async (tx) => {
    await tx.update({ model: 'user', where: [eq('id', user.id)], update: { name: 'After' } });
    await tx.deleteMany({ model: 'user', where: [eq('id', user.id)] });
  });
  const actions = client.send.mock.calls.find(([cmd]) => cmd.constructor.name === 'TransactWriteCommand')[0].input.TransactItems;
  expect(actions.some((a) => a.Delete?.Key.id === user.id)).toBe(true);
});

test('F09: disabling the bulk limit does not silently truncate at 100', async () => {
  const native = { findOne: async () => null, findMany: vi.fn(async ({ limit = 100 }) => Array.from({ length: Math.min(101, limit) }, (_, i) => ({ id: `u${i}` }))), count: async () => 101 };
  const config = { tables, client: { translateConfig: {}, send: vi.fn(async () => ({})) }, maxDeleteManyItems: 0 };
  const transaction = createTransactionWrapper(native, config, (model) => tables[model]);
  // 101 writes exceed DynamoDB capacity: reject before committing a partial 100.
  await expect(transaction((tx) => tx.deleteMany({ model: 'user', where: [{ field: 'name', operator: 'ne', value: 'excluded' }] }))).rejects.toThrow();
});

test('F10: tx.updateMany refreshes numeric TTL alongside expiresAt', async () => {
  const { adapter, client } = setup(reads(row), { ttlFields: { verification: 'expiresAt' } });
  await adapter.transaction((tx) => tx.updateMany({ model: 'verification', where: [eq('id', row.id)], update: { expiresAt: new Date('2030-01-01T00:00:00.000Z') } }));
  const action = client.send.mock.calls.find(([cmd]) => cmd.constructor.name === 'TransactWriteCommand')[0].input.TransactItems[0].Update;
  expect(Object.values(action.ExpressionAttributeNames)).toContain('ttl');
});

test('F11: a future TTL range read still returns matching live rows', async () => {
  const live = { ...row, expiresAt: '2030-01-01T00:00:00.000Z' };
  const { client, config } = setup(reads(live), { ttlFields: { verification: 'expiresAt' } });
  const result = await findOneMethod(client, config)({ model: 'verification', where: [{ field: 'expiresAt', operator: 'lt', value: new Date('2040-01-01') }] });
  expect(result).toMatchObject({ id: row.id });
});

test('F12: null equality includes an absent nullable field', async () => {
  const { adapter } = setup(reads(user)); // image is absent, a valid nullable field
  expect(await adapter.findOne({ model: 'user', where: [eq('id', user.id), eq('image', null)] })).not.toBeNull();
});

test('F13: scan budget stops pagination before all pages are fetched', async () => {
  let calls = 0;
  const client = { send: vi.fn(async () => ({ Items: [{ id: String(++calls), name: 'a' }], ScannedCount: 1, ...(calls < 5 ? { LastEvaluatedKey: { id: String(calls) } } : {}) })) };
  await expect(findManyMethod(client, { client, tables, maxScanItems: 1 })({ model: 'user', sortBy: { field: 'name', direction: 'asc' }, limit: 1 })).rejects.toThrow();
  expect(calls).toBeLessThan(5);
});

test('F14: existing-row tx.update restores Date output fields', async () => {
  const { adapter } = setup(reads(user));
  const result = await adapter.transaction((tx) => tx.update({ model: 'user', where: [eq('id', user.id)], update: { name: 'After' } }));
  expect(result.updatedAt).toBeInstanceOf(Date);
});

test('F03: GSI consume retains its predicate as an atomic delete condition', async () => {
  const { client, config } = setup(reads(row), { indexes: { verification: { identifier: { indexName: 'by-identifier', hashKey: 'identifier' } } } });
  await consumeOneMethod(client, config)({ model: 'verification', where: [eq('identifier', row.identifier), eq('value', row.value)] });
  const cmd = client.send.mock.calls.find(([cmd]) => cmd.constructor.name === 'DeleteCommand')[0];
  expect(cmd.input.ConditionExpression).toBeTruthy();
});

test('F15: insensitive mode is rejected consistently for PK and scan plans', async () => {
  const { adapter } = setup(reads(user));
  await expect(adapter.findOne({ model: 'user', where: [{ ...eq('id', 'u1'), mode: 'insensitive' }] })).rejects.toThrow();
});

const hasIncrementOne = typeof setup(reads(user)).adapter.incrementOne === 'function';
test.skipIf(!hasIncrementOne)('F16: Better Auth 1.7 concurrent increments retain both increments', async () => {
  let count = 0;
  const { adapter } = setup(async (cmd) => {
    if (cmd.constructor.name === 'GetCommand') return { Item: { ...user, count } };
    if (cmd.constructor.name === 'UpdateCommand') {
      for (const match of cmd.input.ConditionExpression.matchAll(/(#c\d+) = (:c\d+)/g)) {
        const currentRow = typeof count === 'number' ? { ...user, count } : current;
        if (currentRow[cmd.input.ExpressionAttributeNames[match[1]]] !== cmd.input.ExpressionAttributeValues[match[2]]) {
          throw Object.assign(new Error('Predicate changed'), { name: 'ConditionalCheckFailedException' });
        }
      }
      for (const assignment of cmd.input.UpdateExpression.slice(4).split(', ')) {
        const [name, value] = assignment.split(' = ');
        if (cmd.input.ExpressionAttributeNames[name] === 'count') count = cmd.input.ExpressionAttributeValues[value];
      }
      return { Attributes: { ...user, count } };
    }
    throw new Error('Unexpected command');
  }, {}, { user: { additionalFields: { count: { type: 'number' } } } });
  await Promise.all([1, 2].map(() => adapter.incrementOne({ model: 'user', where: [eq('id', user.id)], increment: { count: 1 } })));
  expect(count).toBe(2);
});

test.skipIf(!hasIncrementOne)('F16: Better Auth 1.7 transaction exposes incrementOne', async () => {
  const { adapter } = setup(reads(user));
  await adapter.transaction(async (tx) => { expect(typeof tx.incrementOne).toBe('function'); });
});

test('F17: transactional create applies configured operation middleware', async () => {
  const onBeforeCreate = vi.fn();
  const { adapter } = setup(async () => ({}), { extensions: [{ name: 'audit', onBeforeCreate }] });
  await adapter.transaction((tx) => tx.create({ model: 'user', data: user }));
  expect(onBeforeCreate).toHaveBeenCalledOnce();
});

test('control: ordinary findOne rejects the same false extra predicate as F02', async () => {
  const { adapter } = setup(reads(user));
  expect(await adapter.findOne({ model: 'user', where: [eq('id', user.id), eq('email', 'someone-else@example.test')] })).toBeNull();
});

test('control: primary-key consumeOne emits its extra condition atomically', async () => {
  const { client, config } = setup(reads(row));
  await consumeOneMethod(client, config)({ model: 'verification', where: [eq('id', row.id), eq('value', row.value)] });
  const cmd = client.send.mock.calls.find(([cmd]) => cmd.constructor.name === 'DeleteCommand')[0];
  expect(cmd.input.ConditionExpression).toBeTruthy();
  expect(Object.values(cmd.input.ExpressionAttributeNames)).toContain('value');
});
