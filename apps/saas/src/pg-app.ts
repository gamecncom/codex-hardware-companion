import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from './pg-store.js';
import { PgBusinessRepository } from './pg-repository.js';
import { apiError, apiOk } from '@companion/protocol';
import { catalogPage } from './pg-catalog.js';
import { PgDevicePairing, type DevicePairingOptions } from './pg-device-pairing.js';
import { PgConnectorLogin } from './pg-connector-login.js';
import { renderPairingPage } from './pairing-page.js';
import { getDeviceState } from './pg-device-state.js';
import { listDevices, renameDevice, revokeBinding } from './pg-device-management.js';
import { createDeviceView, readDeviceJpeg } from './pg-device-view.js';
import { getTaskGrants, putTaskGrants, selectOwnedTask } from './pg-task-grants.js';
import { handleRecordingRequest } from './pg-recordings.js';
import { handleMessageRequest } from './pg-messages.js';
import { handleAlertRequest } from './pg-alerts.js';
import { getTaskDetail } from './pg-task-detail.js';
import { createV03Pairing, getGrantPreset, putGrantPreset, prepareUnbind, confirmUnbind, readVoiceMultipart, voicePair, voicePairStatus, deviceIdFromBootstrap } from './pg-v03.js';
import type { AsrAdapter } from './asr.js';
import { serveInstallAsset } from './install-assets.js';
async function read(r: IncomingMessage) { let s = ''; for await (const c of r)
    s += c; return s ? JSON.parse(s) : {}; }
const send = (r: any, s: number, v: any) => { r.statusCode = s; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(v)); };
export function createPgApp(db: PostgresStore, options: DevicePairingOptions & { asr?: AsrAdapter; mailProvider?: { send(email: string, code: string): Promise<void> }; installAssetRoot?: string } = {}) { const repo = new PgBusinessRepository(db); const pairing = new PgDevicePairing(db, options); return createServer(async (req, res) => { const id = randomUUID().replaceAll('-', '').slice(0, 32); try {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    if (await serveInstallAsset(req, res, u.pathname, options.installAssetRoot)) return;
    if (await new PgConnectorLogin(db, { publicBaseUrl: options.publicBaseUrl ?? '' }).handle(req, res, u.pathname)) return;
    if (req.method === 'GET' && u.pathname === '/pair') {
        const pairingId = u.searchParams.get('devicePairingId'), challenge = u.searchParams.get('challenge');
        if (!pairingId || !challenge || pairingId.length > 128 || challenge.length > 128) throw Error('INVALID_REQUEST');
        res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(renderPairingPage(pairingId, challenge)); return;
    }
    if (req.method === 'GET' && u.pathname === '/healthz')
        return send(res, 200, apiOk(id, { status: 'ok', storage: 'postgres' }));
    if (req.method === 'POST' && u.pathname === '/v1/auth/email/start') { if (!options.mailProvider) throw Error('CONFIG_MISSING'); const x = await read(req); return send(res, 200, apiOk(id, await repo.emailStart(x.email, options.mailProvider))); }
    if (req.method === 'POST' && u.pathname === '/v1/auth/email/verify') { const x = await read(req); return send(res, 200, apiOk(id, await repo.emailVerify(x.email, x.code))); }
    if (req.method === 'POST' && u.pathname === '/v1/connectors/register') { const x = await read(req); return send(res, 200, apiOk(id, await repo.registerConnector(token, x.name ?? 'Connector'))); }
    if (req.method === 'POST' && u.pathname === '/v1/connectors/bootstrap') { const x = await read(req); return send(res, 201, apiOk(id, await repo.registerAnonymousConnector(x.clientId, x.name ?? 'Mac Connector'))); }
    if (req.method === 'POST' && u.pathname === '/v1/pairings') { const x = await read(req); return send(res, 200, apiOk(id, await createV03Pairing(db, token, x.clientRequestId))); }
    if (req.method === 'POST' && u.pathname === '/v1/device-pairings') { const x = await read(req); return send(res, 200, apiOk(id, await pairing.start(token, x.clientRequestId))); }
    const pairingPoll = /^\/v1\/device-pairings\/([^/]+)\/poll$/.exec(u.pathname);
    const pairingClaim = /^\/v1\/device-pairings\/([^/]+)\/claim$/.exec(u.pathname);
    if (req.method === 'POST' && pairingClaim) { const x = await read(req); return send(res, 200, apiOk(id, await pairing.claim(token, decodeURIComponent(pairingClaim[1]), x.code, x.challenge))); }
    const pairingConfirm = /^\/v1\/device-pairings\/([^/]+)\/confirm$/.exec(u.pathname);
    if (req.method === 'POST' && pairingConfirm) { const x = await read(req); return send(res, 200, apiOk(id, await pairing.confirm(token, decodeURIComponent(pairingConfirm[1]), x.pollSecret, x.clientRequestId))); }
    if (req.method === 'POST' && pairingPoll) { const x = await read(req); return send(res, 200, apiOk(id, await pairing.poll(token, decodeURIComponent(pairingPoll[1]), x.pollSecret))); }
    const voiceStatus = /^\/v1\/device-pairing\/voice\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'POST' && u.pathname === '/v1/device-pairing/voice') {
        const deviceId = deviceIdFromBootstrap(options, token), parsed = await readVoiceMultipart(req);
        return send(res, 202, apiOk(id, await voicePair(db, options.asr, token, deviceId, parsed.clientRequestId, parsed.audio)));
    }
    if (req.method === 'GET' && voiceStatus) {
        const deviceId = deviceIdFromBootstrap(options, token);
        return send(res, 200, apiOk(id, await voicePairStatus(db, token, deviceId, decodeURIComponent(voiceStatus[1]))));
    }
    if (req.method === 'POST' && u.pathname === '/v1/device/binding/recover') { const x = await read(req); return send(res, 200, apiOk(id, await pairing.recover(token, x.clientRequestId))); }
    if (!token)
        throw Error('UNAUTHORIZED');
    if (req.method === 'GET' && u.pathname === '/v1/connectors/self/grant-preset') return send(res, 200, apiOk(id, await getGrantPreset(db, token)));
    if (req.method === 'PUT' && u.pathname === '/v1/connectors/self/grant-preset') return send(res, 200, apiOk(id, await putGrantPreset(db, token, await read(req))));
    const unbindPrepare = /^\/v1\/bindings\/([^/]+)\/unbind\/prepare$/.exec(u.pathname);
    if (req.method === 'POST' && unbindPrepare) { const x = await read(req); return send(res, 200, apiOk(id, await prepareUnbind(db, token, decodeURIComponent(unbindPrepare[1]), x.intent))); }
    if (req.method === 'POST' && u.pathname === '/v1/device/unbind/confirm') { const x = await read(req); return send(res, 200, apiOk(id, await confirmUnbind(db, token, x.operationId, x.clientRequestId))); }
    if (await handleRecordingRequest(db, options.asr, req, res, token, u.pathname)) return;
    if (await handleMessageRequest(db, req, res, token, u.pathname)) return;
    if (await handleAlertRequest(db, token, req, res, u.pathname)) return;
    if (req.method === 'GET' && u.pathname === '/v1/device/state') return send(res, 200, apiOk(id, await getDeviceState(db, token)));
    if (req.method === 'GET' && u.pathname === '/v1/device/task') return send(res, 200, apiOk(id,
      await getTaskDetail(db, token, u.searchParams.get('threadId') ?? '', u.searchParams.get('projectId') ?? undefined)));
    if (req.method === 'GET' && u.pathname === '/v1/devices') return send(res, 200, apiOk(id, await listDevices(db, token)));
    const taskGrants = /^\/v1\/bindings\/([^/]+)\/task-grants$/.exec(u.pathname);
    if (taskGrants && req.method === 'GET') return send(res, 200, apiOk(id, await getTaskGrants(db, token, decodeURIComponent(taskGrants[1]))));
    if (taskGrants && req.method === 'PUT') return send(res, 200, apiOk(id, await putTaskGrants(db, token, decodeURIComponent(taskGrants[1]), await read(req))));
    const managedDevice = /^\/v1\/devices\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'PATCH' && managedDevice) { const x = await read(req); return send(res, 200, apiOk(id, await renameDevice(db, token, decodeURIComponent(managedDevice[1]), x.name, x.clientRequestId))); }
    const managedBinding = /^\/v1\/bindings\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'DELETE' && managedBinding) { const x = await read(req); return send(res, 200, apiOk(id, await revokeBinding(db, token, decodeURIComponent(managedBinding[1]), x.clientRequestId))); }
    if (req.method === 'GET' && u.pathname === '/v1/device/view') {
        const kind = u.searchParams.get('screen');
        if (kind !== 'projects' && kind !== 'tasks' && kind !== 'detail' && kind !== 'transcript') throw Error('INVALID_REQUEST');
        const choice = Number(u.searchParams.get('choice') ?? 0);
        if (!Number.isInteger(choice) || choice < 0) throw Error('INVALID_REQUEST');
        const layout = u.searchParams.get('layout');
        if (layout !== null && layout !== 'compact') throw Error('INVALID_REQUEST');
        if (layout === 'compact' && kind !== 'detail') throw Error('INVALID_REQUEST');
        const query = { kind, recordingId: u.searchParams.get('recordingId') ?? undefined, projectId: u.searchParams.get('projectId') ?? undefined, threadId: u.searchParams.get('threadId') ?? undefined, page: Number(u.searchParams.get('page') ?? 0), choice, cursor: u.searchParams.get('cursor') ?? undefined, limit: 5, ...(layout === 'compact' ? { layout: 'compact' as const } : {}) } as const;
        return send(res, 200, apiOk(id, await createDeviceView(db, token, query)));
    }
    const jpegView = /^\/v1\/device\/views\/([^/]+)\.jpg$/.exec(u.pathname);
    if (req.method === 'GET' && jpegView) {
        const jpeg = await readDeviceJpeg(db, token, decodeURIComponent(jpegView[1]));
        res.statusCode = 200; res.setHeader('content-type', 'image/jpeg');
        res.setHeader('cache-control', 'private, no-store'); res.end(jpeg); return;
    }
    if (req.method === 'GET' && (u.pathname === '/v1/device/projects' || u.pathname === '/v1/device/tasks')) {
        const limit = Number(u.searchParams.get('limit') ?? 5);
        if (!Number.isInteger(limit) || limit < 1)
            throw Error('INVALID_REQUEST');
        const auth = await db.pool.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active'", [token]);
        if (!auth.rowCount)
            throw Error('UNAUTHORIZED');
        if (u.pathname.endsWith('tasks')) {
            const project = u.searchParams.get('projectId');
            if (!project)
                throw Error('INVALID_REQUEST');
            return send(res, 200, apiOk(id, await catalogPage(db, token, 'tasks', project, limit, u.searchParams.get('cursor'))));
        }
        return send(res, 200, apiOk(id, await catalogPage(db, token, 'projects', '', limit, u.searchParams.get('cursor'))));
    }
    if (req.method === 'POST' && u.pathname === '/v1/device/selection') {
        const x = await read(req);
        const auth = await db.pool.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active'", [token]);
        if (!auth.rowCount) {
            if (typeof x.bindingId !== 'string') throw Error('UNAUTHORIZED');
            return send(res, 200, apiOk(id, await selectOwnedTask(db, token, x.bindingId, x)));
        }
        return send(res, 200, apiOk(id, await repo.select(token, x.target, x.expectedSelectionRevision, x.clientRequestId)));
    }
    return send(res, 404, apiError(id, 'NOT_FOUND', 'route not found'));
}
catch (e) {
    const c = e instanceof Error ? e.message : 'INVALID_REQUEST';
    return send(res, c === 'UNAUTHORIZED' ? 401 : c === 'TARGET_NOT_GRANTED' ? 403 : ['SELECTION_CONFLICT','CATALOG_CHANGED','IDEMPOTENCY_CONFLICT'].includes(c) ? 409 : c === 'PAYLOAD_TOO_LARGE' ? 413 : 400, apiError(id, c as any, c));
} }); }
