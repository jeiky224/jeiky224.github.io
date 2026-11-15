(() => {
  'use strict';

  const VERSION = 4;
  const APP_ID = 'wayward-cloudsave';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const CLIENT_ID = String(window.WAYWARD_GOOGLE_CLIENT_ID || '').trim();
  const $ = id => document.getElementById(id);
  const connectionTitle = $('connection-title');
  const connectionStatus = $('connection-status');
  const authPanel = $('auth-panel');
  const requestDescription = $('request-description');
  const confirmRequest = $('confirm-request');
  const authStatus = $('auth-status');
  const connectButton = $('connect');
  const cancelButton = $('cancel');

  let initialized = false;
  let locked = false;
  let completed = false;
  let authPending = false;
  let resultSent = false;
  let errorSent = false;
  let port = null;
  let pendingPorts = [];
  let nonce = '';
  let requestId = '';
  let attemptId = '';
  let sessionId = '';
  let forceSelectAccount = true;
  let authTimer = null;
  let ackTimer = null;
  let openerWatchTimer = null;

  function setConnection(message, error) {
    connectionStatus.textContent = String(message || '');
    connectionStatus.classList.toggle('error', error === true);
  }
  function setAuth(message, error) {
    authStatus.textContent = String(message || '');
    authStatus.classList.toggle('error', error === true);
  }
  function validId(value) {
    return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
  }
  function makeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  function exactKeys(value, allowed) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).every(key => allowed.includes(key));
  }
  function validEnvelope(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      value.version === VERSION && value.appId === APP_ID && value.nonce === nonce &&
      value.requestId === requestId && value.attemptId === attemptId &&
      value.sessionId === sessionId;
  }
  function sendOn(targetPort, type, extra) {
    if (!targetPort || completed) return false;
    try {
      targetPort.postMessage(Object.assign({
        type, version: VERSION, appId: APP_ID, nonce, requestId, attemptId, sessionId
      }, extra || {}));
      return true;
    } catch (_) {
      return false;
    }
  }
  function send(type, extra) {
    return sendOn(port, type, extra);
  }
  function clearTimers() {
    if (authTimer !== null) clearTimeout(authTimer);
    if (ackTimer !== null) clearTimeout(ackTimer);
    if (openerWatchTimer !== null) clearInterval(openerWatchTimer);
    authTimer = null;
    ackTimer = null;
    openerWatchTimer = null;
  }
  function finishPage(message) {
    if (completed) return;
    completed = true;
    authPending = false;
    resultSent = false;
    clearTimers();
    setAuth(message || '인증 세션이 종료되었습니다.');
    connectButton.disabled = true;
    cancelButton.disabled = true;
    window.setTimeout(() => {
      for (const candidate of pendingPorts) { try { candidate.close(); } catch (_) {} }
      pendingPorts = [];
      port = null;
      try { window.close(); } catch (_) {}
    }, 700);
  }
  function sendAuthError(code, message) {
    if (completed || !port || resultSent || errorSent) return;
    authPending = false;
    errorSent = true;
    if (authTimer !== null) clearTimeout(authTimer);
    authTimer = null;
    connectButton.disabled = true;
    cancelButton.disabled = true;
    setAuth(message || 'Google 인증을 완료하지 못했습니다.', true);
    if (!send('wayward-cloud-auth-error', {
      code: String(code || 'auth-error'),
      message: String(message || 'Google 인증을 완료하지 못했습니다.')
    })) {
      finishPage('원래 게임 창에 오류 결과를 전달하지 못했습니다.');
      return;
    }
    ackTimer = window.setTimeout(() => {
      if (!completed) finishPage('인증 실패 결과를 게임에서 확인하지 못했습니다. 다시 시작하세요.');
    }, 3000);
  }
  function closeUnexpectedPorts(event) {
    try {
      for (const candidate of (event && event.ports) || []) {
        try { candidate.close(); } catch (_) {}
      }
    } catch (_) {}
  }
  function readyGIS() {
    return !!(window.google && window.google.accounts && window.google.accounts.oauth2 &&
      typeof window.google.accounts.oauth2.initTokenClient === 'function');
  }
  function waitForGIS(deadline) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (readyGIS()) { resolve(); return; }
        if (Date.now() >= deadline) {
          reject(new Error('Google Identity 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인하세요.'));
          return;
        }
        window.setTimeout(check, 100);
      };
      check();
    });
  }
  function beginLogin() {
    if (completed || !locked || authPending || resultSent || errorSent ||
        !port || !confirmRequest.checked) return;
    if (!readyGIS()) {
      setAuth('Google 인증 서비스를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.', true);
      return;
    }
    if (!/^[^@\s]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) {
      sendAuthError('client-config', 'Google OAuth Web Client 설정을 확인할 수 없습니다.');
      return;
    }
    if ('userActivation' in navigator && navigator.userActivation &&
        navigator.userActivation.isActive !== true) {
      setAuth('브라우저의 사용자 동작 확인이 필요합니다. 이 창에서 연결 버튼을 다시 누르세요.', true);
      return;
    }

    authPending = true;
    connectButton.disabled = true;
    cancelButton.disabled = false;
    setAuth('Google 계정 선택 및 Drive appData 권한을 요청하고 있습니다.');
    let oauthState = '';
    try {
      oauthState = makeNonce();
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        include_granted_scopes: true,
        callback: response => {
          if (completed || !authPending || resultSent || errorSent) return;
          if (!response || response.error || !response.access_token) {
            sendAuthError(String(response && response.error || 'token-error'),
              String(response && (response.error_description || response.error) || 'Google 액세스 토큰을 받지 못했습니다.'));
            return;
          }
          if (response.state !== oauthState) {
            sendAuthError('state-mismatch', 'Google OAuth state가 없거나 일치하지 않습니다. 인증 결과를 거부했습니다.');
            return;
          }
          let granted = false;
          try { granted = google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE); } catch (_) {}
          if (!granted) granted = String(response.scope || '').split(/\s+/).includes(DRIVE_SCOPE);
          if (!granted) {
            sendAuthError('scope_missing', 'Google Drive appData 권한이 승인되지 않았습니다.');
            return;
          }

          authPending = false;
          resultSent = true;
          if (authTimer !== null) clearTimeout(authTimer);
          authTimer = null;
          setAuth('Google 인증 결과를 원래 게임 창에 전달하고 수신 확인을 기다립니다.');
          const sent = send('wayward-cloud-auth-success', {
            accessToken: response.access_token,
            expiresIn: Number(response.expires_in) || 3600
          });
          if (!sent) {
            resultSent = false;
            finishPage('게임 연결이 끊겨 인증 결과를 전달하지 못했습니다. 게임에서 다시 시작하세요.');
            return;
          }
          ackTimer = window.setTimeout(() => {
            if (!completed) finishPage('게임의 인증 결과 확인 응답이 도착하지 않았습니다. 다시 연결하세요.');
          }, 15000);
        },
        error_callback: error => {
          if (completed || !authPending || resultSent || errorSent) return;
          const reason = String(error && error.type || 'popup_error');
          const message = reason === 'popup_closed'
            ? 'Google 계정 선택 창이 닫혔습니다.'
            : reason === 'popup_failed_to_open'
              ? '브라우저가 Google 인증 팝업을 차단했습니다. 팝업을 허용하고 다시 시도하세요.'
              : 'Google 인증 UI를 열지 못했습니다: ' + reason;
          sendAuthError(reason, message);
        }
      });
      authTimer = window.setTimeout(() => {
        if (authPending && !completed) sendAuthError('auth-timeout', 'Google 인증 응답 시간이 초과되었습니다. 다시 연결하세요.');
      }, 120000);
      // GIS starts synchronously from this page's explicit user click.
      client.requestAccessToken({
        prompt: forceSelectAccount ? 'select_account' : '',
        state: oauthState
      });
    } catch (error) {
      sendAuthError('request-failed', String(error && error.message || error));
    }
  }
  function attachPendingPort(candidatePort) {
    if (pendingPorts.includes(candidatePort)) return true;
    if (pendingPorts.length >= 96) {
      try { candidatePort.close(); } catch (_) {}
      return false;
    }
    pendingPorts.push(candidatePort);
    candidatePort.onmessage = event => onPortMessage(event, candidatePort);
    candidatePort.onmessageerror = () => {
      pendingPorts = pendingPorts.filter(item => item !== candidatePort);
      if (port === candidatePort) finishPage('게임과의 보안 메시지 채널이 손상되었습니다.');
      else { try { candidatePort.close(); } catch (_) {} }
    };
    try { if (typeof candidatePort.start === 'function') candidatePort.start(); }
    catch (_) {
      pendingPorts = pendingPorts.filter(item => item !== candidatePort);
      try { candidatePort.close(); } catch (_) {}
      return false;
    }
    return true;
  }
  function onPortMessage(event, sourcePort) {
    const data = event && event.data;
    if (!validEnvelope(data)) return;
    if (data.type === 'wayward-cloud-auth-activate') {
      if (locked || !initialized || !pendingPorts.includes(sourcePort)) return;
      locked = true;
      port = sourcePort;
      const unusedPorts = pendingPorts.filter(candidate => candidate !== port);
      pendingPorts = [port];
      for (const candidate of unusedPorts) { try { candidate.close(); } catch (_) {} }
      connectionTitle.textContent = '일회성 게임 세션 연결됨';
      setConnection('원래 게임 창과 일회성 인증 세션을 확인했습니다. 로컬 파일의 정품 여부는 브라우저가 증명할 수 없습니다.');
      authPanel.hidden = false;
      requestDescription.textContent = 'Wayward CloudSave가 Google Drive appData 접근을 요청했습니다. 직접 시작한 게임 요청인지 확인한 뒤 계속하세요.';
      if (!send('wayward-cloud-auth-active')) {
        finishPage('게임 창에 인증 채널 활성화 상태를 전달하지 못했습니다.');
        return;
      }
      waitForGIS(Date.now() + 20000).then(() => {
        if (completed || !locked) return;
        connectButton.disabled = !confirmRequest.checked;
        setAuth('게임 연결을 활성화했습니다. 요청 확인 후 Google 계정을 연결하세요.');
      }).catch(error => sendAuthError('gis-unavailable', String(error && error.message || error)));
      return;
    }
    if (!locked || sourcePort !== port) return;
    if (data.type === 'wayward-cloud-auth-cancel') {
      finishPage('게임에서 인증 요청을 취소했습니다.');
      return;
    }
    if (data.type === 'wayward-cloud-auth-ack') {
      if (data.accepted === true && !resultSent) return;
      if (ackTimer !== null) clearTimeout(ackTimer);
      ackTimer = null;
      const accepted = data.accepted === true && resultSent;
      send('wayward-cloud-auth-ack-received', {
        accepted,
        message: accepted ? '' : String(data.message || '게임에서 인증 결과를 승인하지 않았습니다.')
      });
      finishPage(accepted
        ? '인증 결과가 원래 게임 세션에 전달되었습니다.'
        : String(data.message || '게임에서 인증 결과를 승인하지 않았습니다.'));
    }
  }
  function onWindowMessage(event) {
    const incoming = event && event.ports;
    if (!incoming || incoming.length !== 1) {
      closeUnexpectedPorts(event);
      return;
    }
    const candidatePort = incoming[0];
    // A file:// sender normally serializes to the opaque Origin "null".
    // This is only an Origin class, not proof of a genuine Wayward binary.
    if (!event || event.origin !== 'null') {
      try { candidatePort.close(); } catch (_) {}
      setConnection('허용되지 않은 발신 Origin입니다. PC 로컬 file:// 게임에서 다시 시작하세요.', true);
      return;
    }
    // Opaque Origin does not identify which local file sent the request.
    // Bind to the exact opener WindowProxy as a separate required condition.
    if (locked || !window.opener || window.opener.closed || event.source !== window.opener) {
      try { candidatePort.close(); } catch (_) {}
      return;
    }
    const data = event.data;
    const allowedKeys = ['type', 'version', 'appId', 'action', 'nonce', 'requestId', 'attemptId', 'forceSelectAccount'];
    if (!exactKeys(data, allowedKeys) || Object.keys(data).length !== allowedKeys.length ||
        data.type !== 'wayward-cloud-auth-init' || data.version !== VERSION ||
        data.appId !== APP_ID || data.action !== 'login' ||
        !validId(data.nonce) || !validId(data.requestId) || !validId(data.attemptId) ||
        typeof data.forceSelectAccount !== 'boolean') {
      try { candidatePort.close(); } catch (_) {}
      return;
    }
    if (initialized) {
      if (locked || data.nonce !== nonce || data.requestId !== requestId ||
          data.attemptId !== attemptId || data.forceSelectAccount !== forceSelectAccount) {
        try { candidatePort.close(); } catch (_) {}
        return;
      }
      if (!attachPendingPort(candidatePort) ||
          !sendOn(candidatePort, 'wayward-cloud-auth-ready')) {
        try { candidatePort.close(); } catch (_) {}
      }
      return;
    }
    let newSessionId = '';
    try { newSessionId = makeNonce(); }
    catch (_) {
      try { candidatePort.close(); } catch (_) {}
      setConnection('안전한 세션을 생성하지 못했습니다. 게임에서 다시 시작하세요.', true);
      return;
    }
    initialized = true;
    nonce = data.nonce;
    requestId = data.requestId;
    attemptId = data.attemptId;
    forceSelectAccount = data.forceSelectAccount;
    sessionId = newSessionId;
    if (!attachPendingPort(candidatePort)) {
      initialized = false;
      setConnection('메시지 채널을 시작하지 못했습니다. 게임에서 다시 시작하세요.', true);
      return;
    }
    connectionTitle.textContent = '게임 연결 요청 수신';
    setConnection('Wayward 게임이 시작한 일회성 요청을 받았습니다. 세션 활성화를 확인하고 있습니다.');
    if (!sendOn(candidatePort, 'wayward-cloud-auth-ready')) {
      pendingPorts = pendingPorts.filter(item => item !== candidatePort);
      try { candidatePort.close(); } catch (_) {}
      finishPage('원래 게임 창에 인증 채널 준비 상태를 전달하지 못했습니다.');
      return;
    }
    if (openerWatchTimer === null) {
      openerWatchTimer = window.setInterval(() => {
        try {
          if (!window.opener || window.opener.closed) finishPage('게임 창이 닫혀 인증 세션을 종료했습니다.');
        } catch (_) {
          finishPage('게임 창을 확인할 수 없어 인증 세션을 종료했습니다.');
        }
      }, 500);
    }
  }
  confirmRequest.addEventListener('change', () => {
    connectButton.disabled = !locked || !confirmRequest.checked || !readyGIS() ||
      completed || authPending || resultSent || errorSent;
    if (confirmRequest.checked) setAuth('확인했습니다. Google 계정 연결을 시작할 수 있습니다.');
  });
  connectButton.addEventListener('click', beginLogin);
  cancelButton.addEventListener('click', () => {
    if (completed || !port) {
      try { window.close(); } catch (_) {}
      return;
    }
    sendAuthError('user_cancelled', '사용자가 인증 페이지에서 요청을 취소했습니다.');
    cancelButton.disabled = true;
  });
  window.addEventListener('message', onWindowMessage);
  window.addEventListener('pagehide', () => {
    clearTimers();
    if (!completed && !resultSent && !errorSent) {
      errorSent = true;
      const notifyPorts = port ? [port] : pendingPorts.slice();
      for (const candidate of notifyPorts) {
        try {
          candidate.postMessage({
            type: 'wayward-cloud-auth-error',
            version: VERSION,
            appId: APP_ID,
            nonce,
            requestId,
            attemptId,
            sessionId,
            code: 'auth-page-unloaded',
            message: '인증 페이지가 새로고침되거나 닫혀 요청을 종료했습니다. 게임에서 다시 연결하세요.'
          });
        } catch (_) {}
      }
    }
    // Do not close ports in the same task as postMessage: close() can discard
    // the queued pagehide error before the game receives it. Document teardown
    // releases the page-side endpoints after the notification is queued.
    pendingPorts = [];
    port = null;
  });
  if (!window.opener) {
    setConnection('Wayward 게임에서 시작한 인증 요청이 아닙니다. 이 페이지를 닫고 게임의 CloudSave 로그인 버튼을 누르세요.', true);
  }
  if (!CLIENT_ID) setConnection('Google OAuth Web Client 설정을 불러오지 못했습니다.', true);
})();
