import { beforeAll, describe, expect, test } from 'bun:test';
import type { Branch, Customer, Page } from '@shop/shared';
import { addMember, call, newCustomer, prepareDatabase, randomCnic, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('customers', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let mainBranch: string;
  let secondBranch: Branch;

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    mainBranch = shop.session.branches[0]._id;
    secondBranch = (await call<Branch>('POST', '/branches', { token: shop.token, body: { name: 'Saddar' } })).data;
  });

  test('a customer is stored in canonical form and comes back with their home branch', async () => {
    const res = await call<Customer>('POST', '/customers', {
      token: shop.token,
      body: newCustomer(mainBranch, {
        cnic: '35202-1234567-1',
        phone: '+92 300 1112223',
        guarantors: [{ fullName: 'Imran Ali', cnic: '35202-7654321-9', phone: '0321 4445556', relation: 'brother' }],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      cnic: '3520212345671',
      phone: '03001112223',
      homeBranchId: mainBranch,
      homeBranch: { _id: mainBranch, name: 'Main Branch' },
      guarantors: [{ fullName: 'Imran Ali', cnic: '3520276543219', phone: '03214445556', relation: 'brother' }],
    });
    expect((await call<Customer>('GET', `/customers/${res.data._id}`, { token: shop.token })).data.fullName).toBe('Muhammad Usman');
  });

  test('a CNIC is registered once per retailer, and the conflict points to the existing customer', async () => {
    const cnic = randomCnic();
    const first = await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch, { cnic }) });
    const duplicate = await call('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch, { cnic, fullName: 'Someone Else' }) });
    expect(duplicate.status).toBe(409);
    expect(duplicate.error?.details).toMatchObject({ customerId: first.data._id, fields: [{ path: 'cnic' }] });

    const otherRetailer = await signupOrg('Other Shop');
    const elsewhere = await call('POST', '/customers', { token: otherRetailer.token, body: newCustomer(otherRetailer.session.branches[0]._id, { cnic }) });
    expect(elsewhere.status).toBe(201);
  });

  test('search finds a customer by name, CNIC or mobile, however it is typed', async () => {
    const created = (
      await call<Customer>('POST', '/customers', {
        token: shop.token,
        body: newCustomer(mainBranch, { fullName: 'Zainab Bibi', cnic: '42101-9988776-5', phone: '0333 9876543' }),
      })
    ).data;
    const search = async (q: string) =>
      (await call<Page<Customer>>('GET', `/customers?q=${encodeURIComponent(q)}`, { token: shop.token })).data.items.map((c) => c._id);

    expect(await search('zainab')).toContain(created._id);
    expect(await search('42101-99887')).toContain(created._id);
    expect(await search('+92 333 98765')).toContain(created._id);
    expect(await search('Nobody Like This')).toEqual([]);
  });

  test('pages are newest first and do not overlap', async () => {
    const other = await signupOrg('Paging Shop');
    const branch = other.session.branches[0]._id;
    for (const fullName of ['First Person', 'Second Person', 'Third Person']) {
      await call('POST', '/customers', { token: other.token, body: newCustomer(branch, { fullName }) });
    }
    const first = await call<Page<Customer>>('GET', '/customers?limit=2', { token: other.token });
    expect(first.data.items.map((c) => c.fullName)).toEqual(['Third Person', 'Second Person']);
    const second = await call<Page<Customer>>('GET', `/customers?limit=2&cursor=${first.data.nextCursor}`, { token: other.token });
    expect(second.data.items.map((c) => c.fullName)).toEqual(['First Person']);
    expect(second.data.nextCursor).toBeNull();
  });

  test('staff find every customer of the retailer, but add customers only at their own branch', async () => {
    const staff = await addMember(shop.token, 'staff', [secondBranch._id]);
    const atMain = await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch) });
    expect((await call('GET', `/customers/${atMain.data._id}`, { token: staff.token })).status).toBe(200);

    expect((await call('POST', '/customers', { token: staff.token, body: newCustomer(mainBranch) })).status).toBe(403);
    expect((await call('POST', '/customers', { token: staff.token, body: newCustomer(secondBranch._id) })).status).toBe(201);
  });

  test('editing changes only what was sent; only the owner can delete', async () => {
    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    const customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch) })).data;

    const edited = await call<Customer>('PATCH', `/customers/${customer._id}`, { token: staff.token, body: { address: 'New address, Model Town' } });
    expect(edited.data).toMatchObject({ address: 'New address, Model Town', cnic: customer.cnic, phone: customer.phone });

    expect((await call('DELETE', `/customers/${customer._id}`, { token: staff.token })).status).toBe(403);
    expect((await call('DELETE', `/customers/${customer._id}`, { token: shop.token })).status).toBe(200);
    expect((await call('GET', `/customers/${customer._id}`, { token: shop.token })).status).toBe(404);
  });

  test("another retailer can't read or change a customer", async () => {
    const customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch) })).data;
    const other = await signupOrg('Snooping Shop');
    expect((await call('GET', `/customers/${customer._id}`, { token: other.token })).status).toBe(404);
    expect((await call('PATCH', `/customers/${customer._id}`, { token: other.token, body: { notes: 'x' } })).status).toBe(404);
    const list = await call<Page<Customer>>('GET', '/customers', { token: other.token });
    expect(list.data.items.map((c) => c._id)).not.toContain(customer._id);
  });
});
