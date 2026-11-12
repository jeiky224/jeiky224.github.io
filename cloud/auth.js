(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const gameOrigin = params.get('origin') || '';
  const nonce = params.get('nonce') || '';
  const loginPolicy = params.get('login') === 'select_account' ? 'select_account' : 'remember';
  const nativeTransportRequested = params.get('transport') === 'custom-tabs';
  const AUTH_ORIGIN = 'https://jeiky224.github.io';
  const clientId = String(window.WAYWARD_GOOGLE_CLIENT_ID || '').trim();
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const PROTOCOL_VERSION = 1;
  const MAX_REQUESTS = 65536;
  const MAX_PAYLOAD_CHARS = 12 * 1024 * 1024;

  const connectButton = $('connect');
  const selectButton = $('select-account');
  const logoutButton = $('logout');
  const revokeButton = $('revoke');
  const statusNode = $('status');
  const accountStatus = $('account-status');
  const driveStatus = $('drive-status');
  const originTitle = $('origin-title');
  const originDetail = $('origin-detail');
  const originValue = $('origin-value');
  const confirmWrap = $('confirm-wrap');
  const confirmBox = $('confirm');
  const confirmCopy = $('confirm-copy');

  let ready = false;
  let openerSeen = false;
  let userConfirmed = false;
  let sessionId = '';
  let tokenTimer = null;
  let popupWatchTimer = null;
  let connected = false;
  let requestCount = 0;
  const seenRequestIds = new Set();
  let nativePort = null;
  let nativeTransportClosed = false;
  const nativeTransfers = new Map();
  const MAX_NATIVE_MESSAGE_BYTES = 12 * 1024 * 1024;
  const NATIVE_CHUNK_CHARS = 24 * 1024;
  const MAX_NATIVE_CHUNKS = 768;

  function setStatus(message, error) {
    statusNode.textContent = String(message || '');
    statusNode.classList.toggle('error', error === true);
  }

  function setAccountStatus(message, error) {
    accountStatus.textContent = String(message || '');
    accountStatus.classList.toggle('error', error === true);
  }

  function setDriveStatus(message, error) {
    driveStatus.textContent = String(message || '');
    driveStatus.classList.toggle('error', error === true);
  }

  function makeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  function classifyOrigin(value) {
    if (value === 'null') return 'file';
    let parsed;
    try { parsed = new URL(value); }
    catch (_) { return 'invalid'; }
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        parsed.origin !== value || parsed.username || parsed.password) return 'invalid';
    return parsed.protocol === 'https:' ? 'https' : 'http';
  }

  const originKind = classifyOrigin(gameOrigin);
  const fileMode = originKind === 'file';
  const expectedEventOrigin = fileMode ? 'null' : gameOrigin;
  const nonceValid = /^[a-f0-9]{48}$/.test(nonce);
  const originValid = originKind !== 'invalid';

  function openerAlive() {
    if (nativeTransportRequested) return !!nativePort && !nativeTransportClosed;
    try { return !!window.opener && !window.opener.closed; }
    catch (_) { return false; }
  }

  function targetGameOrigin() {
    return fileMode ? '*' : gameOrigin;
  }

  function encodeUtf8Base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return { bytes, encoded: btoa(binary) };
  }

  function decodeUtf8Base64(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_NATIVE_MESSAGE_BYTES * 4 / 3) + 8) return null;
    let binary;
    try { binary = atob(value); } catch (_) { return null; }
    if (binary.length > MAX_NATIVE_MESSAGE_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { return null; }
  }

  function sendNativePayload(payload) {
    if (!nativePort || nativeTransportClosed) return false;
    let raw;
    try { raw = JSON.stringify(payload); } catch (_) { return false; }
    let encoded;
    try { encoded = encodeUtf8Base64(raw); } catch (_) { return false; }
    if (encoded.bytes.length > MAX_NATIVE_MESSAGE_BYTES) return false;
    try {
      if (encoded.bytes.length <= NATIVE_CHUNK_CHARS) {
        nativePort.postMessage(raw);
        return true;
      }
      const id = makeNonce();
      const total = Math.ceil(encoded.encoded.length / NATIVE_CHUNK_CHARS);
      if (total > MAX_NATIVE_CHUNKS) return false;
      for (let seq = 0; seq < total; seq++) {
        nativePort.postMessage(JSON.stringify({
          __waywardCctChunk: 1, id, seq, total,
          data: encoded.encoded.slice(seq * NATIVE_CHUNK_CHARS, (seq + 1) * NATIVE_CHUNK_CHARS)
        }));
      }
      return true;
    } catch (_) { return false; }
  }

  function receiveNativePayload(raw) {
    if (typeof raw !== 'string' || raw.length > NATIVE_CHUNK_CHARS + 512) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return null; }
    if (!parsed || parsed.__waywardCctChunk !== 1) return parsed;
    if (typeof parsed.id !== 'string' || !/^[a-f0-9]{48}$/.test(parsed.id) ||
        !Number.isSafeInteger(parsed.seq) || !Number.isSafeInteger(parsed.total) ||
        parsed.total < 2 || parsed.total > MAX_NATIVE_CHUNKS || parsed.seq < 0 ||
        parsed.seq >= parsed.total || typeof parsed.data !== 'string' ||
        parsed.data.length > NATIVE_CHUNK_CHARS) return null;
    const now = Date.now();
    for (const [key, value] of nativeTransfers) {
      if (now - value.createdAt > 60000) nativeTransfers.delete(key);
    }
    let transfer = nativeTransfers.get(parsed.id);
    if (!transfer) {
      if (nativeTransfers.size >= 4) nativeTransfers.delete(nativeTransfers.keys().next().value);
      transfer = { total: parsed.total, chunks: new Array(parsed.total), chars: 0, received: 0, createdAt: now };
      nativeTransfers.set(parsed.id, transfer);
    }
    if (transfer.total !== parsed.total) { nativeTransfers.delete(parsed.id); return null; }
    if (transfer.chunks[parsed.seq] === undefined) {
      transfer.chunks[parsed.seq] = parsed.data;
      transfer.chars += parsed.data.length;
      transfer.received += 1;
    } else if (transfer.chunks[parsed.seq] !== parsed.data) {
      nativeTransfers.delete(parsed.id);
      return null;
    }
    if (transfer.chars > Math.ceil(MAX_NATIVE_MESSAGE_BYTES * 4 / 3) + 8) {
      nativeTransfers.delete(parsed.id);
      return null;
    }
    if (transfer.received !== transfer.total) return null;
    nativeTransfers.delete(parsed.id);
    const complete = decodeUtf8Base64(transfer.chunks.join(''));
    if (complete == null) return null;
    try { return JSON.parse(complete); } catch (_) { return null; }
  }

  function baseMessage(type, extra) {
    return Object.assign({
      type,
      version: PROTOCOL_VERSION,
      nonce
    }, extra || {});
  }

  function sendToGame(type, extra) {
    if (!openerSeen || !openerAlive() || !nonceValid || !originValid) return false;
    const payload = baseMessage(type, extra);
    if (sessionId) payload.sessionId = sessionId;
    if (nativeTransportRequested) return sendNativePayload(payload);
    try {
      window.opener.postMessage(payload, targetGameOrigin());
      return true;
    } catch (_) {
      return false;
    }
  }

  function sendStatus(status, message, extra) {
    const payload = Object.assign({ status: String(status), message: String(message || '') }, extra || {});
    sendToGame('wayward-cloudsave-status', payload);
    setAccountStatus(message || status, status !== 'connected' && status !== 'logged-out');
  }

  function clearTokenTimer() {
    if (tokenTimer !== null) {
      clearTimeout(tokenTimer);
      tokenTimer = null;
    }
  }

  function clearPageToken() {
    clearTokenTimer();
    try {
      if (window.WaywardCloudSaveDrive) window.WaywardCloudSaveDrive.clearAccessToken();
    } catch (_) {}
    connected = false;
    updateButtons();
  }

  function updateButtons() {
    const canAuth = ready && openerSeen && userConfirmed && openerAlive();
    connectButton.disabled = !canAuth;
    selectButton.disabled = !canAuth;
    logoutButton.disabled = !connected;
    revokeButton.disabled = !connected;
  }

  function showConfirm() {
    confirmWrap.hidden = false;
    confirmBox.checked = false;
    userConfirmed = false;
    confirmCopy.textContent = fileMode
      ? 'Wayward 게임에서 직접 시작한 인증 요청입니다. 이 게임 창의 Drive 접근을 허용합니다.'
      : 'Wayward 게임 인증 요청 · ' + gameOrigin;
    updateButtons();
  }

  function failClosed(message) {
    clearPageToken();
    userConfirmed = false;
    ready = false;
    connectButton.disabled = true;
    selectButton.disabled = true;
    logoutButton.disabled = true;
    revokeButton.disabled = true;
    setStatus(message, true);
    setAccountStatus('게임 연결을 확인할 수 없습니다.', true);
    setDriveStatus('Drive 접근이 차단되었습니다.', true);
  }

  function validParentMessage(event, data, fromNative) {
    if (!data || typeof data !== 'object' || data.version !== PROTOCOL_VERSION || data.nonce !== nonce) return false;
    if (fromNative) return nativeTransportRequested && !!nativePort && !nativeTransportClosed;
    return openerAlive() && event && event.source === window.opener && event.origin === expectedEventOrigin;
  }

  function exactKeys(value, allowed, required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.some(key => !allowed.includes(key))) return false;
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key));
  }

  function validSlot(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 1000000000;
  }

  function sendResponse(requestId, ok, data, error) {
    const extra = { requestId, ok: ok === true };
    if (ok) extra.data = data == null ? null : data;
    else extra.error = {
      code: String(error && error.code || 'request-failed'),
      message: String(error && error.message || 'Google Drive 요청에 실패했습니다.'),
      status: Number(error && error.status || 0)
    };
    sendToGame('wayward-cloudsave-response', extra);
  }

  function validateRequest(data) {
    if (!data || data.type !== 'wayward-cloudsave-request' ||
        data.version !== PROTOCOL_VERSION ||
        data.nonce !== nonce ||
        data.sessionId !== sessionId ||
        typeof data.requestId !== 'string' ||
        !/^[a-f0-9]{48}$/.test(data.requestId) ||
        typeof data.action !== 'string' ||
        !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
      return false;
    }
    if (seenRequestIds.has(data.requestId) || requestCount >= MAX_REQUESTS) return false;
    const payload = data.payload;
    switch (data.action) {
      case 'list':
      case 'logout':
      case 'revoke':
        return exactKeys(payload, [], []);
      case 'read':
      case 'delete':
        return exactKeys(payload, ['slot'], ['slot']) && validSlot(payload.slot);
      case 'save':
        return exactKeys(payload, ['slot', 'envelope'], ['slot', 'envelope']) &&
          validSlot(payload.slot) &&
          payload.envelope && typeof payload.envelope === 'object' &&
          !Array.isArray(payload.envelope);
      default:
        return false;
    }
  }

  async function processRequest(data) {
    const { requestId, action, payload } = data;
    seenRequestIds.add(requestId);
    requestCount += 1;
    if (seenRequestIds.size > MAX_REQUESTS) {
      clearPageToken();
      sendResponse(requestId, false, null, {
        code: 'session-request-limit',
        message: '이 인증 세션에서 허용된 요청 수를 초과했습니다. 게임에서 새 연결을 시작하세요.'
      });
      return;
    }

    if (action === 'logout') {
      clearPageToken();
      sendStatus('logged-out', '로그아웃되었습니다. Google 앱 권한은 유지됩니다.');
      setDriveStatus('로그아웃됨');
      sendResponse(requestId, true, { loggedOut: true });
      return;
    }

    if (action === 'revoke') {
      if (!connected || !window.WaywardCloudSaveDrive ||
          typeof window.google?.accounts?.oauth2?.revoke !== 'function') {
        sendResponse(requestId, false, null, {
          code: 'revoke-unavailable',
          message: '철회할 Google 토큰이 없거나 Google 철회 API를 사용할 수 없습니다.'
        });
        sendStatus('revoke-failed', 'Google 앱 권한 철회를 확인하지 못했습니다.');
        return;
      }
      setDriveStatus('Google에 앱 권한 철회를 요청하는 중…');
      let result = null;
      try {
        result = await window.WaywardCloudSaveDrive.revokeAccess(
          (token, callback) => google.accounts.oauth2.revoke(token, callback)
        );
      } catch (error) {
        result = { successful: false, error: String(error && error.message || error) };
      }
      connected = false;
      clearTokenTimer();
      updateButtons();
      if (result && result.successful === true) {
        sendStatus('permission-revoked', 'Google 앱 권한이 해제되었습니다.');
        setDriveStatus('Google 앱 권한이 철회되었습니다.');
        sendResponse(requestId, true, { revoked: true });
      } else {
        sendStatus('revoke-failed', 'Google에서 권한 해제를 확인하지 못했습니다.');
        setDriveStatus('권한 철회가 확인되지 않았습니다.', true);
        sendResponse(requestId, false, null, {
          code: 'revoke-failed',
          message: 'Google이 권한 철회 성공을 확인하지 않았습니다.'
        });
      }
      return;
    }

    if (!connected || !window.WaywardCloudSaveDrive ||
        !window.WaywardCloudSaveDrive.hasAccessToken()) {
      connected = false;
      updateButtons();
      sendStatus('reauth-required', '액세스 토큰이 만료되었습니다. 계정을 다시 연결하세요.');
      sendResponse(requestId, false, null, {
        code: 'reauth-required',
        message: 'Google 액세스 토큰이 만료되었거나 아직 연결되지 않았습니다.'
      });
      return;
    }

    try {
      const jsonLength = JSON.stringify(payload).length;
      if (jsonLength > MAX_PAYLOAD_CHARS) {
        throw { code: 'request-too-large', message: 'Google Drive 요청 데이터가 허용된 크기를 초과했습니다.' };
      }
      const result = await window.WaywardCloudSaveDrive.perform(action, payload);
      sendResponse(requestId, true, result);
      if (action === 'list') {
        const count = Array.isArray(result && result.files) ? result.files.length : 0;
        setDriveStatus('Google Drive 저장 슬롯 목록을 확인했습니다. (' + count + '개)');
      } else if (action === 'save') {
        setDriveStatus('저장 슬롯 ' + payload.slot + ' 저장을 완료했습니다.');
      } else if (action === 'delete') {
        setDriveStatus('저장 슬롯 ' + payload.slot + ' 삭제를 완료했습니다.');
      } else if (action === 'read') {
        setDriveStatus('저장 슬롯 ' + payload.slot + ' 데이터를 전달했습니다.');
      }
    } catch (error) {
      const code = String(error && error.code || 'drive-error');
      if (code === 'reauth-required') {
        clearPageToken();
        sendStatus('reauth-required', error.message);
      } else if (code === 'scope-missing') {
        clearPageToken();
        sendStatus('scope-missing', error.message);
      } else if (code === 'permission-revoked') {
        clearPageToken();
        sendStatus('permission-revoked', error.message);
      } else if (code === 'permission-denied') {
        sendStatus('permission-denied', error.message);
      } else {
        sendStatus(code, error && error.message || 'Google Drive 요청에 실패했습니다.');
      }
      setDriveStatus(error && error.message || 'Google Drive 요청 실패', true);
      sendResponse(requestId, false, null, error);
    }
  }

  function handleParentData(data, event, fromNative) {
    if (!validParentMessage(event, data, fromNative)) return;

    if (data.type === 'wayward-cloudsave-native-close') {
      nativeTransportClosed = true;
      clearPageToken();
      failClosed('Wayward 게임 세션이 종료되어 인증 연결과 메모리 토큰을 정리했습니다.');
      try { if (nativePort) nativePort.close(); } catch (_) {}
      nativePort = null;
      return;
    }

    if (data.type === 'wayward-cloudsave-hello') {
      if (openerSeen || !/^[a-f0-9]{48}$/.test(nonce)) return;
      openerSeen = true;
      try { sessionId = makeNonce(); }
      catch (_) { failClosed('이 브라우저에서 암호학적 난수를 생성하지 못했습니다.'); return; }
      originTitle.textContent = nativeTransportRequested
        ? 'Wayward 런처 보안 메시지 연결 확인됨'
        : 'Wayward 게임 팝업의 핸드셰이크 확인됨';
      originDetail.textContent = nativeTransportRequested
        ? 'Digital Asset Links로 검증된 Custom Tabs 메시지 채널과 게임 세션 nonce를 확인했습니다.'
        : (fileMode
          ? '게임 Origin은 opaque origin(null)이며, 실제 opener 창과 일회성 nonce가 확인되었습니다.'
          : '실제 opener 창, 지정된 게임 Origin, 일회성 nonce가 확인되었습니다.');
      originValue.textContent = '게임 Origin: ' + gameOrigin;
      showConfirm();
      return;
    }

    if (data.type === 'wayward-cloudsave-request') {
      if (!ready || !userConfirmed || !sessionId || data.sessionId !== sessionId) return;
      if (requestCount >= MAX_REQUESTS &&
          typeof data.requestId === 'string' &&
          /^[a-f0-9]{48}$/.test(data.requestId) &&
          !seenRequestIds.has(data.requestId)) {
        sendStatus('session-request-limit', '이 인증 세션의 Drive 요청 한도에 도달했습니다. 새 연결을 시작하세요.');
        sendResponse(data.requestId, false, null, {
          code: 'session-request-limit',
          message: '인증 세션 요청 한도를 초과했습니다.'
        });
        return;
      }
      if (!validateRequest(data)) return;
      processRequest(data).catch(error => sendResponse(data.requestId, false, null, error));
    }
  }

  function initializeNativePort(event) {
    if (!nativeTransportRequested || nativePort || nativeTransportClosed ||
        !event || event.origin !== AUTH_ORIGIN || !event.ports || event.ports.length !== 1) return false;
    let init = event.data;
    if (typeof init === 'string') {
      try { init = JSON.parse(init); } catch (_) { return false; }
    }
    if (!init || init.type !== 'wayward-cloudsave-cct-init' ||
        init.version !== PROTOCOL_VERSION || init.nonce !== nonce) return false;
    const port = event.ports[0];
    if (!port || typeof port.postMessage !== 'function') return false;
    nativePort = port;
    nativePort.onmessage = messageEvent => {
      const payload = receiveNativePayload(messageEvent && messageEvent.data);
      if (payload) handleParentData(payload, null, true);
    };
    nativePort.onmessageerror = () => {
      nativeTransportClosed = true;
      clearPageToken();
      failClosed('런처와의 보안 메시지 채널이 종료되었습니다. 게임에서 다시 연결하세요.');
    };
    try { if (typeof nativePort.start === 'function') nativePort.start(); }
    catch (_) { failClosed('런처 메시지 채널을 시작하지 못했습니다.'); return false; }
    openerSeen = true;
    try { sessionId = makeNonce(); }
    catch (_) { failClosed('이 브라우저에서 암호학적 난수를 생성하지 못했습니다.'); return false; }
    originTitle.textContent = 'Wayward 런처 보안 메시지 채널 연결됨';
    originDetail.textContent = 'Digital Asset Links로 검증된 런처 origin과 일회성 게임 nonce를 확인했습니다.';
    originValue.textContent = '게임 Origin: ' + gameOrigin;
    if (!sendToGame('wayward-cloudsave-page-ready')) {
      failClosed('Wayward 런처에 인증 페이지 준비 상태를 전달하지 못했습니다.');
      return false;
    }
    return true;
  }

  function onParentMessage(event) {
    if (nativeTransportRequested && event && event.origin === AUTH_ORIGIN) {
      if (event.ports && event.ports.length) {
        initializeNativePort(event);
        return;
      }
      const payload = receiveNativePayload(event.data);
      if (payload) handleParentData(payload, null, true);
      return;
    }
    if (nativeTransportRequested) return;
    handleParentData(event && event.data, event, false);
  }

  window.addEventListener('message', onParentMessage);

  function beginConnection(forceSelectAccount) {
    if (!ready || !openerSeen || !userConfirmed || !openerAlive()) {
      setStatus('Wayward 게임 팝업 연결을 먼저 확인해야 합니다.', true);
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2 ||
        typeof google.accounts.oauth2.initTokenClient !== 'function') {
      setStatus('Google Identity 라이브러리를 아직 사용할 수 없습니다.', true);
      return;
    }
    connectButton.disabled = true;
    selectButton.disabled = true;
    setAccountStatus('Google 계정 및 Drive 접근 권한을 확인하고 있습니다.');
    setStatus('Google 인증을 시작합니다…');

    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        include_granted_scopes: true,
        callback: response => {
          if (!response || response.error || !response.access_token) {
            const code = String(response && response.error || 'token-error');
            if (code === 'access_denied') {
              clearPageToken();
              sendStatus('consent-denied', 'Google 계정 또는 Drive 권한 승인이 거부되었습니다.');
              setStatus('Google 계정 또는 권한 승인이 거부되었습니다.', true);
            } else {
              clearPageToken();
              sendStatus('reauth-required', response && (response.error_description || response.error) || 'Google 인증 정보를 받지 못했습니다.');
              setStatus('Google 인증에 실패했습니다.', true);
            }
            updateButtons();
            return;
          }
          let granted = false;
          try { granted = google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE); }
          catch (_) {}
          if (!granted) {
            granted = String(response.scope || '').split(/\s+/).includes(DRIVE_SCOPE);
          }
          if (!granted) {
            clearPageToken();
            sendStatus('scope-missing', '필수 Google Drive 권한이 승인되지 않았습니다.');
            setStatus('Google Drive appData 권한이 부족합니다. 권한을 다시 승인하세요.', true);
            updateButtons();
            return;
          }
          try {
            window.WaywardCloudSaveDrive.setAccessToken(response.access_token, response.expires_in);
          } catch (error) {
            sendStatus('reauth-required', String(error && error.message || error));
            setStatus('Google 토큰을 설정하지 못했습니다.', true);
            updateButtons();
            return;
          }
          connected = true;
          const seconds = Math.max(60, Math.min(3600, Number(response.expires_in) || 3600));
          if (tokenTimer !== null) clearTimeout(tokenTimer);
          tokenTimer = setTimeout(() => {
            clearPageToken();
            sendStatus('reauth-required', 'Google 인증이 만료되었습니다. 다시 연결하세요.');
            setDriveStatus('액세스 토큰 만료 — 재인증 필요', true);
            setStatus('Google 인증이 만료되었습니다. 연결 버튼을 눌러 갱신하세요.', true);
          }, Math.max(1000, (seconds - 15) * 1000));
          updateButtons();
          sendStatus('connected', 'Google 계정이 연결되었습니다.');
          setDriveStatus('Google Drive에 연결됨');
          setStatus('연결 완료. Drive 작업을 사용할 수 있습니다.');
        },
        error_callback: error => {
          const type = String(error && error.type || 'popup_error');
          if (type === 'popup_closed') {
            clearPageToken();
            sendStatus('auth-cancelled', '인증 창이 닫혔습니다.');
            setStatus('Google 인증 창이 닫혔습니다.', true);
          } else if (type === 'popup_failed_to_open') {
            clearPageToken();
            sendStatus('popup-blocked', '브라우저가 인증 팝업을 차단했습니다.');
            setStatus('Google 인증 팝업이 차단되었습니다. 이 페이지의 팝업을 허용하세요.', true);
          } else {
            sendStatus('reauth-required', type);
            setStatus('Google 인증 UI를 열지 못했습니다: ' + type, true);
          }
          updateButtons();
        }
      });
      client.requestAccessToken({ prompt: forceSelectAccount ? 'select_account' : '' });
    } catch (error) {
      sendStatus('reauth-required', String(error && error.message || error));
      setStatus('Google 인증을 시작하지 못했습니다.', true);
      updateButtons();
    }
  }

  function explicitLogout() {
    if (window.WaywardCloudSaveDrive) window.WaywardCloudSaveDrive.clearAccessToken();
    connected = false;
    clearTokenTimer();
    sendStatus('logged-out', '이 페이지의 메모리에서 Google 액세스 토큰을 삭제했습니다. Google 앱 권한 동의는 유지됩니다.');
    setDriveStatus('로그아웃됨');
    setStatus('로그아웃 완료. Google 앱 권한은 유지됩니다.');
    updateButtons();
  }

  function onConfirmChanged() {
    userConfirmed = confirmBox.checked;
    if (userConfirmed && openerSeen && !ready && openerAlive()) {
      confirmBox.disabled = true;
      ready = true;
      sendToGame('wayward-cloudsave-ready', { sessionId });
      setStatus('게임 연결 완료. Google 계정을 연결하세요.');
      setAccountStatus('인증 준비 완료');
    } else if (!userConfirmed) {
      ready = false;
      clearPageToken();
      setStatus('게임 창에 Drive 명령을 허용하지 않았습니다.');
    }
    updateButtons();
  }

  function waitForGIS(deadline) {
    if (window.google && google.accounts && google.accounts.oauth2 &&
        typeof google.accounts.oauth2.initTokenClient === 'function') {
      setStatus(ready ? '인증 준비 완료' : '게임 연결 확인을 기다리고 있습니다.');
      updateButtons();
      return;
    }
    if (Date.now() >= deadline) {
      setStatus('Google 인증 서비스를 불러오지 못했습니다. 네트워크 연결을 확인하세요.', true);
      connectButton.disabled = true;
      selectButton.disabled = true;
      return;
    }
    setTimeout(() => waitForGIS(deadline), 100);
  }

  if (!nonceValid || !originValid || !/^[^@\s]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    failClosed('유효하지 않은 인증 요청입니다. 게임에서 다시 연결하세요.');
    return;
  }

  if (!nativeTransportRequested && !openerAlive()) {
    failClosed('Wayward 게임 창을 찾을 수 없습니다. 게임에서 다시 연결하세요.');
    return;
  }

  confirmWrap.hidden = false;
  confirmBox.addEventListener('change', onConfirmChanged);
  connectButton.addEventListener('click', () => beginConnection(false));
  selectButton.addEventListener('click', () => beginConnection(true));
  logoutButton.addEventListener('click', explicitLogout);
  revokeButton.addEventListener('click', async () => {
    if (!connected || !window.WaywardCloudSaveDrive) return;
    revokeButton.disabled = true;
    setDriveStatus('Google에 권한 철회를 요청하는 중…');
    let result = null;
    try {
      result = await window.WaywardCloudSaveDrive.revokeAccess(
        (token, callback) => google.accounts.oauth2.revoke(token, callback)
      );
    } catch (_) {
      result = { successful: false };
    }
    connected = false;
    clearTokenTimer();
    updateButtons();
    if (result && result.successful === true) {
      sendStatus('permission-revoked', 'Google 앱 권한이 해제되었습니다.');
      setDriveStatus('Google 앱 권한이 철회되었습니다.');
      setStatus('Google 앱 권한 철회를 완료했습니다.');
    } else {
      sendStatus('revoke-failed', 'Google에서 권한 해제를 확인하지 못했습니다.');
      setDriveStatus('권한 철회가 확인되지 않았습니다.', true);
      setStatus('Google 앱 권한 철회에 실패했거나 결과가 확인되지 않았습니다.', true);
    }
  });

  window.addEventListener('message', onParentMessage);
  window.addEventListener('pagehide', () => {
    if (ready && openerSeen && userConfirmed && openerAlive()) {
      sendStatus('reauth-required', '인증 페이지가 새로고침되거나 닫혀 세션을 종료했습니다.');
    }
    clearPageToken();
  });

  // Native Custom Tabs initializes the channel with a MessagePort-bearing message.
  // Ordinary browsers keep the original real-window.opener protocol.
  if (nativeTransportRequested) {
    setStatus('런처의 보안 메시지 채널을 기다리고 있습니다.');
    setTimeout(() => {
      if (!nativePort && !nativeTransportClosed) {
        failClosed('런처의 Custom Tabs 메시지 채널을 확인하지 못했습니다. 앱과 웹 연결 설정을 확인하세요.');
      }
    }, 20000);
  } else {
    try {
      window.opener.postMessage(baseMessage('wayward-cloudsave-page-ready'), targetGameOrigin());
    } catch (_) {
      failClosed('Wayward 게임 창에 연결 준비 메시지를 보내지 못했습니다.');
      return;
    }

    popupWatchTimer = setInterval(() => {
      if (!openerAlive()) {
        clearTokenTimer();
        clearPageToken();
        if (popupWatchTimer !== null) clearInterval(popupWatchTimer);
        popupWatchTimer = null;
        failClosed('Wayward 게임 창이 닫혀 연결을 종료했습니다. 토큰은 메모리에서 삭제했습니다.');
      }
    }, 1000);
  }

  waitForGIS(Date.now() + 20000);
})();
