(() => {
  const errorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'AggregateError']);

  function cleanMessage(value) {
    if (typeof value !== 'string') return 'Error details unavailable';
    if (/\b(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|infoToken|authorization|cookie|bearer|password|passwd|client[_-]?secret|sdk[_-]?openid)\b/i.test(value)) {
      return 'Sensitive error message omitted';
    }
    return value
      .replace(/(?:https?|wss?|tauri):\/\/[^\s<>"'()]+/gi, '[url omitted]')
      .replace(/[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*/g, '[value omitted]')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 400);
  }

  function sourceFrames(value) {
    if (typeof value !== 'string') return [];
    const locations = value.split('\n')
      .filter(line => /^\s*at\s|@|^(?:https?|wss?|tauri):\/\//.test(line))
      .map(line => line.replace(/[?#][^\s)]*/g, ''))
      .join('\n');
    return [...locations.matchAll(/(?:^|[\s/@(])([A-Za-z0-9_$.-]{1,120}\.m?js):(\d+)(?::(\d+))?/g)]
      .slice(0, 8)
      .map((match) => `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ''}`);
  }

  function describeError(reason) {
    if (!(reason instanceof Error)) return null;
    return {
      name: errorNames.has(reason.name) ? reason.name : 'Error',
      message: cleanMessage(reason.message),
      frames: sourceFrames(reason.stack),
    };
  }

  function writeDiagnostic(message) {
    const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
    if (typeof invoke !== 'function') {
      console.error('[macOS] Diagnostic bridge unavailable');
      return;
    }
    try {
      Promise.resolve(invoke('write_app_log', { level: 'error', message }))
        .catch(() => console.error('[macOS] Could not write diagnostic log'));
    } catch {
      console.error('[macOS] Could not write diagnostic log');
    }
  }

  window.addEventListener('error', event => {
    const error = describeError(event.error);
    const frames = error?.frames.length ? error.frames : sourceFrames(`at ${event.filename}:${event.lineno}:${event.colno}`);
    writeDiagnostic(`[webview] ${error ? `${error.name}: ${error.message}` : cleanMessage(event.message)}${frames.length ? ` at ${frames.join(' <- ')}` : ''}`);
  });
  window.addEventListener('unhandledrejection', event => {
    const error = describeError(event.reason);
    writeDiagnostic(error
      ? `[webview:unhandledrejection] ${error.name}: ${error.message}${error.frames.length ? ` at ${error.frames.join(' <- ')}` : ''}`
      : '[webview:unhandledrejection] Non-Error rejection');
  });

  const state = { nativeInput: false };
  const productName = window.__WUWATAPPO_PROFILE__?.productName ?? 'Wuwa Tappo CN Mac';
  const isMainWindow = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label === 'main';
  if (isMainWindow) {
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      document.addEventListener(type, event => {
        if (state.nativeInput && event.isTrusted) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }
  }
  const initialize = async () => {
    const api = window.__TAURI__;
    if (!api) return;
    let attemptedRecovery = false;
    let checking = false;
    let previousStatus;
    const update = status => {
      state.nativeInput = status?.running === true;
      if (!isMainWindow) return;
      if (status?.granted === false || status?.running) attemptedRecovery = false;
      let warning = document.getElementById('wuwatappo-input-status');
      if (status?.running) warning?.remove();
      else {
        if (!warning) {
          warning = document.createElement('div');
          warning.id = 'wuwatappo-input-status';
          warning.setAttribute('role', 'status');
          warning.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:420px;padding:12px 16px;border-radius:10px;background:#fff2df;color:#59321a;font:14px/1.5 system-ui;box-shadow:0 2px 16px #0002;pointer-events:none';
          (document.body || document.documentElement).append(warning);
        }
        warning.textContent = status?.error === 'input_status_unavailable'
          ? '无法读取键鼠监听状态。请从菜单“启用键鼠监听”重试。'
          : !status?.granted
            ? `键鼠计数已暂停：请在系统设置 → 输入监控中重新允许 ${productName}。`
            : '已获得输入监控权限，但监听尚未启动。请从菜单“启用键鼠监听”重试，必要时重启应用。';
      }
      const signature = JSON.stringify([status?.granted ?? null, status?.running ?? null, status?.error ?? null]);
      if (signature !== previousStatus) {
        previousStatus = signature;
        api.core.invoke('write_app_log', { level: 'info', message: `[INPUT] granted=${status?.granted ?? 'unknown'} running=${!!status?.running} error=${status?.error ?? 'none'}` })
          .catch(() => console.error('[macOS] Could not write input status'));
      }
    };
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await api.core.invoke('get_input_status');
        update(status);
        if (isMainWindow && status.granted && !status.running && !attemptedRecovery) {
          attemptedRecovery = true;
          update(await api.core.invoke('resume_input_monitor'));
        }
      } catch {
        update({ granted: null, running: false, error: 'input_status_unavailable' });
      } finally { checking = false; }
    };
    try {
      await api.event.listen('mac-input-status', event => update(event.payload));
      await check();
      if (isMainWindow) {
        const timer = window.setInterval(check, 2000);
        window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
      }
    } catch (error) {
      console.error('[macOS] Input status unavailable', String(error));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
