import { describe, it, expect, vi } from 'vitest';
import { ItemAfterSalesApi } from './item-after-sales-api';
describe('response loss followed by permission revocation', () => {
    it.each([401, 403, 404, 409, 500])('retains the original unresolved after-sales key after recovery HTTP %s', async (status) => {
        const rows = new Map<string, string>(), storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
        const item = '11111111-1111-4111-8111-111111111111', body = { orderItemId: item, quantity: 1, reason: '隔离响应丢失审计' }, url = '/api/commerce/item-after-sales/requests';
        const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('response lost after uncertain commit')).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'QUANTITY_FORBIDDEN', message: '权限已撤销' } }), { status })).mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'later-success' } }), { status: 201 }));
        const api = new ItemAfterSalesApi('synthetic-employee', send, storage);
        await expect(api.act(item, url, body)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
        const firstKey = api.pending(item)?.key;
        expect(firstKey).toBeTruthy();
        await expect(api.recover(item)).rejects.toMatchObject({ status });
        const pendingAfter403 = api.pending(item);
        await api.act(item, url, body);
        const keys = send.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
        console.info(JSON.stringify({ case: 'after-sales-client-403', mode: 'lost-response-then-forbidden-recovery', originalPreserved: pendingAfter403?.key === firstKey, pendingCleared: pendingAfter403 === null, recoveryUsedOriginal: keys[0] === keys[1], nextAttemptChangedKey: keys[2] !== keys[0] }));
        expect(pendingAfter403?.key).toBe(firstKey);
        expect(new Headers(send.mock.calls[1]?.[1]?.headers).get('x-mbox-replay-only')).toBe('true');
        expect(keys[2]).toBe(firstKey);
    });
});
