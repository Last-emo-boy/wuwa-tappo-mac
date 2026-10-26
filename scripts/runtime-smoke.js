(() => {
  const run = async () => {
    const result = {};
    const invoke = window.__TAURI__.core.invoke;
    const name = '__wuwatappo_mac_selftest';
    try {
      document.cookie = `${name}=synthetic; Max-Age=60; Path=/; SameSite=None; Secure`;
      await window.__WUWATAPPO_SESSION__.flush();
      const saved = await invoke('session_snapshot');
      result.keychainWrite = saved.cookies.some(cookie => cookie.name === name && cookie.value === 'synthetic');
      if (!result.keychainWrite) throw new Error('Synthetic session cookie was not committed');
    } finally {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=None; Secure`;
      await window.__WUWATAPPO_SESSION__.flush();
    }
    result.keychainDelete = !(await invoke('session_snapshot')).cookies.some(cookie => cookie.name === name);
    result.input = await invoke('get_input_status');
    result.safeArea = await invoke('get_main_desktop_safe_area');
    await new Promise((resolve, reject) => {
      const started=performance.now();
      const check=()=>{
        const b=document.querySelector('.pet-dock')?.getBoundingClientRect();
        if(b&&b.width>0&&b.height>0&&b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1) return resolve();
        if(performance.now()-started>15000) return reject(new Error(`Pet layout not ready: ${JSON.stringify(b?.toJSON())}; viewport ${innerWidth}x${innerHeight}`));
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const bounds = document.querySelector('.pet-dock').getBoundingClientRect();
    result.petVisible = bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    result.passed = result.keychainWrite && result.keychainDelete && result.petVisible;
    window.__WUWATAPPO_RUNTIME_SMOKE__ = result;
    await invoke('write_app_log', { level: result.passed ? 'info' : 'error', message: `[MAC_SELFTEST] ${JSON.stringify(result)}` });
  };
  const start = () => run().catch(error => {
    window.__TAURI__.core.invoke('write_app_log', { level: 'error', message: `[MAC_SELFTEST] failed: ${String(error)}` }).catch(console.error);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
