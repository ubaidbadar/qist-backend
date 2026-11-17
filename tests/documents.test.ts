import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DEFAULT_DOCUMENT_POLICY,
  type Customer,
  type Device,
  type ContractWithSchedule,
  type DocumentItem,
  type DocumentList,
  addDays,
  todayInShops,
} from '@shop/shared';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { setDocumentRuntimeForTests } from '../src/documents/storage';
import { runDocumentJobs, setDocumentProcessorForTests } from '../src/documents/process_jobs';
import { createDocumentProcessor } from '../src/documents/processor_server';
import { validateDocument } from '../src/documents/validate_file';
import { UnsafeDocumentError } from '../src/documents/errors';
import { Document, DocumentQuota } from '../src/models/document';
import { CustomerAccount } from '../src/models/customer_account';
import { Contract } from '../src/models/contract';
import { signCustomerToken } from '../src/lib/customer_session';
import { addMember, call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

const app = createApp();
const files = new Map<string, Uint8Array>();
let uncertainWrite = false;
let failedDeletes = 0;
const storage = {
  async write(key: string, blob: Blob) {
    files.set(key, new Uint8Array(await blob.arrayBuffer()));
    if (uncertainWrite) {
      uncertainWrite = false;
      throw new Error('Simulated uncertain storage write');
    }
  },
  async read(key: string) {
    const bytes = files.get(key);
    if (!bytes) throw new Error('Missing');
    return bytes;
  },
  async remove(key: string) {
    if (failedDeletes > 0) {
      failedDeletes--;
      throw new Error('Simulated storage outage');
    }
    files.delete(key);
  },
};
const image = () =>
  sharp({ create: { width: 60, height: 90, channels: 3, background: 'white' } })
    .withExif({ IFD0: { Artist: 'Private fixture metadata' } })
    .jpeg()
    .toBuffer();

function pdfFixture(script = false) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${script ? '/OpenAction 5 0 R' : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    ...(script ? ['<< /S /JavaScript /JS (app.alert\\(1\\)) >>'] : []),
  ];
  let content = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((value, i) => {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(content));
}

describe('private file processor', () => {
  test('fully decodes images, strips metadata and rejects HTML disguised as an image', async () => {
    const result = await validateDocument(await image());
    expect(result.contentType).toBe('image/jpeg');
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    expect(result.preview?.length).toBeGreaterThan(0);
    await expect(
      validateDocument(new TextEncoder().encode('<script>not an image</script>')),
    ).rejects.toBeInstanceOf(UnsafeDocumentError);
    await expect(validateDocument(Uint8Array.of(255, 216, 255, 0))).rejects.toBeInstanceOf(
      UnsafeDocumentError,
    );
  });
  test('parses full PDF content and rejects embedded JavaScript and malformed PDFs', async () => {
    expect((await validateDocument(pdfFixture())).contentType).toBe('application/pdf');
    await expect(validateDocument(pdfFixture(true))).rejects.toBeInstanceOf(UnsafeDocumentError);
    await expect(validateDocument(new TextEncoder().encode('%PDF-broken'))).rejects.toBeInstanceOf(
      UnsafeDocumentError,
    );
  });
  test('requires private authentication and fails closed when antivirus is unavailable or rejects', async () => {
    const secret = 's'.repeat(32);
    const processor = createDocumentProcessor(secret, async () => {
      throw new Error('Unavailable');
    });
    expect((await processor.request('/process', { method: 'POST', body: await image() })).status).toBe(401);
    expect(
      (
        await processor.request('/process', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          body: await image(),
        })
      ).status,
    ).toBe(503);
    const rejecting = createDocumentProcessor(secret, async () => {
      throw new UnsafeDocumentError('Fixture');
    });
    expect(
      (
        await rejecting.request('/process', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          body: await image(),
        })
      ).status,
    ).toBe(422);
  });
});

describe.skipIf(!hasDatabase)('private document lifecycle and authorization', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>, other: Awaited<ReturnType<typeof signupOrg>>;
  let customer: Customer,
    contract: ContractWithSchedule,
    customerToken: string,
    sid: string,
    accountId: string,
    staffToken: string;
  const create = (extra: Record<string, unknown> = {}, token = shop.token) =>
    call<DocumentItem>('POST', '/documents', {
      token,
      body: {
        contractId: contract._id,
        category: 'phone_box',
        idempotencyKey: crypto.randomUUID(),
        consent: true,
        ...extra,
      },
    });
  const upload = (id: string, bytes: Uint8Array, token = shop.token, customer = false) =>
    app.request(`/api/v1/${customer ? 'customer-app/' : ''}documents/${id}/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
  const content = (id: string, token = shop.token, customer = false) =>
    app.request(`/api/v1/${customer ? 'customer-app/' : ''}documents/${id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  beforeAll(async () => {
    await prepareDatabase();
    setDocumentRuntimeForTests({ storage });
    setDocumentProcessorForTests(validateDocument);
    shop = await signupOrg();
    other = await signupOrg();
    staffToken = (await addMember(shop.token, 'staff', [shop.session.branches[0]._id])).token;
    customer = (
      await call<Customer>('POST', '/customers', {
        token: shop.token,
        body: newCustomer(shop.session.branches[0]._id, {
          guarantors: [
            {
              fullName: 'Fixture Guarantor',
              cnic: '1234512345671',
              phone: '03001234567',
              relation: 'brother',
            },
          ],
        }),
      })
    ).data;
    const device = (
      await call<Device>('POST', '/devices', {
        token: shop.token,
        body: {
          branchId: shop.session.branches[0]._id,
          brand: 'Test',
          model: 'Phone',
          imeis: [randomImei()],
        },
      })
    ).data;
    contract = (
      await call<ContractWithSchedule>('POST', '/contracts', {
        token: shop.token,
        body: {
          branchId: shop.session.branches[0]._id,
          customerId: customer._id,
          deviceId: device._id,
          cashPrice: 600000,
          downPayment: 100000,
          markupPercent: 0,
          count: 5,
          frequency: 'monthly',
          firstDueDate: addDays(todayInShops(), 30),
        },
      })
    ).data;
    expect(contract._id).toBeDefined();
    sid = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3600000);
    const account = await CustomerAccount.create({
      phone: customer.phone,
      sessions: [{ id: sid, expiresAt }],
    });
    accountId = String(account._id);
    customerToken = await signCustomerToken({ sub: accountId, sid, ver: 0 }, expiresAt);
  });
  afterAll(() => {
    setDocumentRuntimeForTests();
    setDocumentProcessorForTests();
  });

  test('uploads default to disabled and require an owner-configured private service', async () => {
    expect((await create()).status).toBe(503);
    expect(
      (
        await call('PATCH', '/org/documents', {
          token: staffToken,
          body: { ...DEFAULT_DOCUMENT_POLICY, enabled: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('PATCH', '/org/documents', {
          token: shop.token,
          body: { ...DEFAULT_DOCUMENT_POLICY, enabled: true },
        })
      ).status,
    ).toBe(200);
  });
  test('creates are idempotent only for the exact document relationship', async () => {
    const key = crypto.randomUUID();
    const first = await create({ idempotencyKey: key });
    expect(first.status).toBe(201);
    expect((await create({ idempotencyKey: key })).data._id).toBe(first.data._id);
    expect((await create({ idempotencyKey: key, category: 'warranty' })).status).toBe(409);
  });
  test('quarantines uploads, publishes only checked content, and protects review against stale writes', async () => {
    const item = (await create()).data;
    expect((await content(item._id)).status).toBe(403);
    expect((await upload(item._id, await image())).status).toBe(200);
    expect((await content(item._id)).status).toBe(403);
    await runDocumentJobs();
    const response = await content(item._id);
    expect(response.status).toBe(200);
    expect((await content(item._id, staffToken)).status).toBe(403);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const ready = await Document.findOne({ _id: item._id, orgId: shop.session.org._id }).select(
      '+sourceKey +storedKey',
    );
    expect(ready?.sourceKey).toBeUndefined();
    const stored = files.get(ready!.storedKey!)!;
    files.set(ready!.storedKey!, Uint8Array.of(1, 2, 3));
    expect((await content(item._id)).status).toBe(503);
    files.set(ready!.storedKey!, stored);
    expect(
      (
        await call('POST', `/documents/${item._id}/review`, {
          token: staffToken,
          body: { version: ready!.version, decision: 'accepted' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/documents/${item._id}/review`, {
          token: shop.token,
          body: { version: ready!.version, decision: 'accepted' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', `/documents/${item._id}/review`, {
          token: shop.token,
          body: { version: ready!.version, decision: 'rejected', feedback: 'Another copy' },
        })
      ).status,
    ).toBe(409);
    expect((await content(item._id, other.token)).status).toBe(404);
  });
  test('limits streamed bytes and rejects invalid files without publishing any content', async () => {
    const oversized = (await create()).data;
    expect((await upload(oversized._id, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    const unsafe = (await create()).data;
    await upload(unsafe._id, new TextEncoder().encode('<html>not an image</html>'));
    await runDocumentJobs();
    expect((await Document.findOne({ _id: unsafe._id, orgId: shop.session.org._id }))!.processing).toBe(
      'rejected',
    );
    expect((await content(unsafe._id)).status).toBe(403);
  });
  test('uncertain storage writes retain a durable cleanup intent until deletion succeeds', async () => {
    const item = (await create()).data;
    uncertainWrite = true;
    failedDeletes = 1;
    expect((await upload(item._id, await image())).status).toBe(500);
    const interrupted = await Document.findOne({ _id: item._id, orgId: shop.session.org._id }).select(
      '+garbageKeys',
    );
    expect(interrupted!.garbageKeys).toHaveLength(1);
    const key = interrupted!.garbageKeys[0];
    expect(files.has(key)).toBe(true);
    await runDocumentJobs();
    expect(files.has(key)).toBe(false);
    expect(
      (await Document.findOne({ _id: item._id, orgId: shop.session.org._id }).select('+garbageKeys'))!
        .garbageKeys,
    ).toEqual([]);
  });

  test('managers cannot list or retrieve document files outside their assigned branch', async () => {
    const branch = await call<{ _id: string }>('POST', '/branches', {
      token: shop.token,
      body: { name: 'Other document branch' },
    });
    expect(branch.status).toBe(201);
    const manager = await addMember(shop.token, 'manager', [branch.data._id]);
    expect(
      (await call('GET', `/documents?contractId=${contract._id}`, { token: manager.token })).status,
    ).toBe(404);
    expect(
      (await call('GET', `/documents?customerId=${customer._id}`, { token: manager.token })).status,
    ).toBe(403);
    const ready = await Document.findOne({ orgId: shop.session.org._id, processing: 'ready' });
    expect(ready).toBeTruthy();
    expect((await content(String(ready!._id), manager.token)).status).toBe(404);
  });

  test('customer uploads target their selected plan, require consent, and cannot use staff routes', async () => {
    expect(
      (await call('GET', `/documents?contractId=${contract._id}`, { token: customerToken })).status,
    ).toBe(401);
    const listing = await call<DocumentList>('GET', `/customer-app/documents?contractId=${contract._id}`, {
      token: customerToken,
    });
    expect(listing.status).toBe(200);
    expect(listing.data.subjects).toEqual([]);
    expect(
      (
        await call('POST', '/customer-app/documents', {
          token: customerToken,
          body: { contractId: contract._id, category: 'phone_box', idempotencyKey: crypto.randomUUID() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('GET', `/customer-app/documents?customerId=${other.session.user._id}`, {
          token: customerToken,
        })
      ).status,
    ).toBe(404);
    const item = (
      await call<DocumentItem>('POST', '/customer-app/documents', {
        token: customerToken,
        body: {
          contractId: contract._id,
          category: 'warranty',
          idempotencyKey: crypto.randomUUID(),
          consent: true,
        },
      })
    ).data;
    expect((await upload(item._id, await image(), customerToken, true)).status).toBe(200);
    await CustomerAccount.updateOne({ _id: accountId }, { $set: { sessions: [] } });
    expect((await content(item._id, customerToken, true)).status).toBe(404);
    await CustomerAccount.updateOne(
      { _id: accountId },
      { $set: { sessions: [{ id: sid, expiresAt: new Date(Date.now() + 3600000) }] } },
    );
  });
  test('guarantor scans require an explicit request and remain unreadable to customers and ordinary staff', async () => {
    const category = 'guarantor_cnic_front';
    const guarantorId = customer.guarantors[0].id;
    expect(
      (
        await call('POST', '/customer-app/documents', {
          token: customerToken,
          body: {
            contractId: contract._id,
            category,
            guarantorId,
            idempotencyKey: crypto.randomUUID(),
            consent: true,
          },
        })
      ).status,
    ).toBe(400);
    const request = await call<{ _id: string }>('POST', '/documents/requests', {
      token: shop.token,
      body: {
        contractId: contract._id,
        category,
        guarantorId,
        message: 'Please send the front with permission.',
      },
    });
    expect(request.status).toBe(201);
    const item = await call<DocumentItem>('POST', '/customer-app/documents', {
      token: customerToken,
      body: {
        contractId: contract._id,
        category,
        requestId: request.data._id,
        idempotencyKey: crypto.randomUUID(),
        consent: true,
      },
    });
    expect(item.status).toBe(201);
    expect((await upload(item.data._id, await image(), customerToken, true)).status).toBe(200);
    await runDocumentJobs();
    expect((await content(item.data._id, staffToken)).status).toBe(403);
    expect((await content(item.data._id, customerToken, true)).status).toBe(403);
    expect((await content(item.data._id)).status).toBe(200);
  });
  test('replacement acceptance supersedes its original atomically and holds block removal', async () => {
    const original = (await create()).data;
    await upload(original._id, await image());
    await runDocumentJobs();
    const replacement = (await create({ replacesId: original._id })).data;
    await upload(replacement._id, await image());
    await runDocumentJobs();
    expect((await content(original._id)).status).toBe(200);
    const ready = await Document.findOne({ _id: replacement._id, orgId: shop.session.org._id });
    const reviewed = await call<DocumentItem>('POST', `/documents/${replacement._id}/review`, {
      token: shop.token,
      body: { version: ready!.version, decision: 'accepted' },
    });
    expect(reviewed.status).toBe(200);
    expect((await Document.findOne({ _id: original._id, orgId: shop.session.org._id }))!.review).toBe(
      'superseded',
    );
    const held = await call<DocumentItem>('POST', `/documents/${replacement._id}/hold`, {
      token: shop.token,
      body: { version: reviewed.data.version, hold: true },
    });
    expect(held.status).toBe(200);
    expect(
      (
        await call('DELETE', `/documents/${replacement._id}?version=${held.data.version}`, {
          token: shop.token,
        })
      ).status,
    ).toBe(403);
  });
  test('expired uploads release quota; terminal contracts start disclosed retention and held files survive expiry', async () => {
    const item = (await create()).data;
    const orgId = shop.session.org._id;
    const before = (await DocumentQuota.findOne({ _id: `${orgId}:${contract._id}`, orgId }))!.count;
    await Document.collection.updateOne(
      {
        _id: new (await import('mongoose')).Types.ObjectId(item._id),
        orgId: new (await import('mongoose')).Types.ObjectId(orgId),
      },
      { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } },
    );
    await runDocumentJobs();
    expect((await DocumentQuota.findOne({ _id: `${orgId}:${contract._id}`, orgId }))!.count).toBe(before - 1);
    expect((await Document.findOne({ _id: item._id, orgId }))!.processing).toBe('deleted');
    await Contract.updateOne({ _id: contract._id, orgId }, { $set: { status: 'completed' } });
    await runDocumentJobs();
    const retained = await Document.findOne({ orgId, contractId: contract._id, legalHold: true });
    expect(retained!.expiresAt).toBeInstanceOf(Date);
    await Document.updateOne({ _id: retained!._id, orgId }, { $set: { expiresAt: new Date(0) } });
    await runDocumentJobs();
    expect((await Document.findOne({ _id: retained!._id, orgId }))!.processing).toBe('ready');
    await Document.updateOne({ _id: retained!._id, orgId }, { $set: { legalHold: false } });
    await Contract.updateOne({ _id: contract._id, orgId }, { $set: { status: 'active' } });
    await runDocumentJobs();
    expect((await Document.findOne({ _id: retained!._id, orgId }))!.expiresAt).toBeNull();
  });
});
