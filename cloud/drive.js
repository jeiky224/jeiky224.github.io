(() => {
  'use strict';

  const API = 'https://www.googleapis.com';
  const FILE_PREFIX = 'wayward-cloud-slot-';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const MAX_ENVELOPE_CHARS = 12 * 1024 * 1024;
  let accessToken = '';
  let expiresAt = 0;
  let slotFiles = null;

  class CloudSaveDriveError extends Error {
    constructor(code, message, status) {
      super(String(message || code || 'Google Drive 요청에 실패했습니다.'));
      this.name = 'CloudSaveDriveError';
      this.code = String(code || 'drive-error');
      this.status = Number(status || 0);
    }
  }

  function makeError(code, message, status) {
    return new CloudSaveDriveError(code, message, status);
  }

  function requireToken() {
    if (!accessToken || !Number.isFinite(expiresAt) || Date.now() >= expiresAt - 15000) {
      clearAccessToken();
      throw makeError('reauth-required', 'Google 액세스 토큰이 만료되었습니다. 이 인증 페이지에서 다시 연결해 주세요.');
    }
  }

  function clearAccessToken() {
    accessToken = '';
    expiresAt = 0;
    slotFiles = null;
  }

  function setAccessToken(token, expiresIn) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096) {
      throw makeError('invalid-token-response', 'Google에서 유효한 액세스 토큰을 받지 못했습니다.');
    }
    const seconds = Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds < 60 || seconds > 7200) {
      throw makeError('invalid-token-response', 'Google 액세스 토큰의 만료 시간이 올바르지 않습니다.');
    }
    accessToken = token;
    expiresAt = Date.now() + seconds * 1000;
    slotFiles = null;
  }

  async function readApiError(response) {
    try {
      const data = await response.clone().json();
      const error = data && data.error ? data.error : {};
      const reasons = Array.isArray(error.errors)
        ? error.errors.map(item => String(item && item.reason || ''))
        : [];
      return {
        status: String(error.status || ''),
        message: String(error.message || ''),
        reasons
      };
    } catch (_) {
      return { status: '', message: '', reasons: [] };
    }
  }

  async function driveFetch(path, options) {
    requireToken();
    const opts = Object.assign({
      method: 'GET',
      headers: {},
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    }, options || {});
    opts.headers = Object.assign({}, opts.headers || {}, {
      Authorization: 'Bearer ' + accessToken
    });

    let response;
    try {
      response = await fetch(API + path, opts);
    } catch (_) {
      throw makeError(
        'network-error',
        'Google Drive에 연결하지 못했습니다. 네트워크 또는 브라우저 CORS 오류를 확인하세요.'
      );
    }

    if (response.status === 401) {
      clearAccessToken();
      throw makeError('reauth-required', 'Google 인증이 만료되었거나 취소되었습니다. 다시 연결해 주세요.', 401);
    }

    if (response.status === 403) {
      const details = await readApiError(response);
      if (details.reasons.includes('insufficientPermissions')) {
        throw makeError('scope-missing', details.message || 'Google Drive appData 권한이 승인되지 않았습니다.', 403);
      }
      if (details.status === 'PERMISSION_DENIED') {
        throw makeError('permission-denied', details.message || 'Google Drive API가 요청을 거부했습니다. 계정 권한과 앱 설정을 확인하세요.', 403);
      }
      if (details.status === 'RESOURCE_EXHAUSTED') {
        throw makeError('quota-exceeded', details.message || 'Google Drive API 사용량 제한에 도달했습니다.', 403);
      }
      throw makeError('permission-denied', details.message || 'Google Drive가 요청을 거부했습니다.', 403);
    }

    if (response.status === 404) {
      throw makeError('file-not-found', '요청한 Google Drive 세이브 파일을 찾지 못했습니다.', 404);
    }
    if (response.status === 429) {
      throw makeError('rate-limited', 'Google Drive 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
    }
    if (response.status >= 500) {
      const details = await readApiError(response);
      throw makeError('drive-unavailable', details.message || 'Google Drive 서비스가 일시적으로 응답하지 않습니다.', response.status);
    }
    if (!response.ok) {
      const details = await readApiError(response);
      throw makeError('drive-error', details.message || 'Google Drive 요청 실패 (' + response.status + ')', response.status);
    }
    return response;
  }

  function slotNumber(name) {
    const match = new RegExp('^' + FILE_PREFIX + '([1-9][0-9]*)\\.json$').exec(String(name || ''));
    if (!match) return 0;
    const slot = Number(match[1]);
    return Number.isSafeInteger(slot) && slot > 0 ? slot : 0;
  }

  async function listDriveSlots() {
    const result = new Map();
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        pageSize: '100',
        q: 'trashed = false',
        fields: 'files(id,name,modifiedTime,size),nextPageToken'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await driveFetch('/drive/v3/files?' + params.toString());
      const data = await response.json();
      for (const file of (Array.isArray(data.files) ? data.files : [])) {
        const slot = slotNumber(file && file.name);
        if (!slot || !file.id) continue;
        const previous = result.get(slot);
        if (!previous || String(file.modifiedTime || '') > String(previous.modifiedTime || '')) {
          result.set(slot, {
            id: String(file.id),
            name: String(file.name),
            modifiedTime: String(file.modifiedTime || ''),
            size: Number(file.size || 0)
          });
        }
      }
      pageToken = String(data.nextPageToken || '');
    } while (pageToken);

    slotFiles = result;
    return Array.from(result.values()).sort((a, b) =>
      slotNumber(a.name) - slotNumber(b.name)
    );
  }

  function validateSlot(slotValue) {
    const slot = Number(slotValue);
    if (!Number.isSafeInteger(slot) || slot < 1) {
      throw makeError('invalid-request', '저장 슬롯 번호가 올바르지 않습니다.');
    }
    return slot;
  }

  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        envelope.format !== 'wayward-google-drive-save' ||
        envelope.version !== 1 ||
        envelope.keyMode !== 'embedded-addon-v2' ||
        envelope.cipher !== 'AES-256-GCM' ||
        typeof envelope.iv !== 'string' ||
        typeof envelope.ciphertext !== 'string' ||
        envelope.iv.length > 128 ||
        envelope.ciphertext.length > MAX_ENVELOPE_CHARS) {
      throw makeError('invalid-save-data', 'Wayward 암호화 세이브 형식 또는 크기가 올바르지 않습니다.');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) {
      throw makeError('invalid-save-data', '암호화 세이브의 Base64 데이터가 올바르지 않습니다.');
    }
    return envelope;
  }

  async function getSlotFile(slot) {
    if (!slotFiles) await listDriveSlots();
    return slotFiles && slotFiles.get(slot) || null;
  }

  async function list() {
    return { files: await listDriveSlots() };
  }

  async function read(slotValue) {
    const slot = validateSlot(slotValue);
    const file = await getSlotFile(slot);
    if (!file) throw makeError('slot-empty', '저장 슬롯 ' + slot + '이 비어 있습니다.', 404);
    const response = await driveFetch('/drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media');
    let envelope;
    try { envelope = await response.json(); }
    catch (_) { throw makeError('invalid-save-data', 'Google Drive 세이브 JSON을 읽을 수 없습니다.'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw makeError('invalid-save-data', 'Google Drive 세이브 데이터 형식이 올바르지 않습니다.');
    }
    return { slot, file, envelope };
  }

  function randomBoundary() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return 'wayward_cloudsave_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  async function save(slotValue, envelopeValue) {
    const slot = validateSlot(slotValue);
    const envelope = validateEnvelope(envelopeValue);
    const body = JSON.stringify(envelope);
    if (body.length > MAX_ENVELOPE_CHARS) {
      throw makeError('invalid-save-data', '암호화 세이브가 허용된 최대 크기를 초과했습니다.');
    }

    const existing = await getSlotFile(slot);
    if (existing) {
      await driveFetch('/upload/drive/v3/files/' + encodeURIComponent(existing.id) + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body
      });
    } else {
      const boundary = randomBoundary();
      const metadata = {
        name: FILE_PREFIX + slot + '.json',
        mimeType: 'application/json',
        parents: ['appDataFolder']
      };
      const multipart =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        body + '\r\n' +
        '--' + boundary + '--';
      await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: multipart
      });
    }
    slotFiles = null;
    return { saved: true, slot, name: FILE_PREFIX + slot + '.json' };
  }

  async function remove(slotValue) {
    const slot = validateSlot(slotValue);
    const file = await getSlotFile(slot);
    if (!file) throw makeError('slot-empty', '삭제할 저장 슬롯을 찾지 못했습니다.', 404);
    await driveFetch('/drive/v3/files/' + encodeURIComponent(file.id), { method: 'DELETE' });
    slotFiles = null;
    return { deleted: true, slot, name: file.name };
  }

  async function revokeAccess(revokeFn) {
    try { requireToken(); } catch (_) {
      return { successful: false, error: 'reauth-required' };
    }
    if (typeof revokeFn !== 'function') {
      clearAccessToken();
      return { successful: false, error: 'gis-unavailable' };
    }
    const token = accessToken;
    return new Promise(resolve => {
      let settled = false;
      const finish = successful => {
        if (settled) return;
        settled = true;
        clearAccessToken();
        resolve({ successful: successful === true });
      };
      try {
        revokeFn(token, response => finish(!!(response && response.successful === true)));
      } catch (_) {
        finish(false);
      }
    });
  }

  async function perform(action, payload) {
    const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    if (action === 'list') return list();
    if (action === 'read') return read(data.slot);
    if (action === 'save') return save(data.slot, data.envelope);
    if (action === 'delete') return remove(data.slot);
    throw makeError('unsupported-command', '허용되지 않은 Google Drive 명령입니다.');
  }

  window.WaywardCloudSaveDrive = Object.freeze({
    setAccessToken,
    clearAccessToken,
    hasAccessToken: () => !!accessToken && Date.now() < expiresAt - 15000,
    revokeAccess,
    perform
  });
})();
