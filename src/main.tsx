import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

export const plugin = {
  id: "lst-super-resolution",
name: "LST Super-Resolution (SR2D4)",
  version: "1.0.7",
  
  // O underline (_) avisa o TypeScript para ignorar que a variável não é usada
  activate(app: any) {
    console.log("🔥 LST Super-Resolution ativado no GeoLibre!");
    
    const container = document.createElement('div');
    container.id = 'lst-plugin-container';
    container.style.position = 'fixed';
    container.style.top = '72px';
    container.style.right = '20px';
    container.style.width = 'min(440px, calc(100vw - 40px))';
    container.style.height = 'min(760px, calc(100vh - 92px))';
    container.style.maxHeight = 'calc(100vh - 92px)';
    container.style.minWidth = '360px';
    container.style.minHeight = '420px';
    container.style.maxWidth = 'min(900px, calc(100vw - 40px))';
    container.style.overflow = 'visible';
    container.style.zIndex = '1000';
    container.style.pointerEvents = 'none';
    
    document.body.appendChild(container);

    const resizeHandle = document.createElement('button');
    resizeHandle.type = 'button';
    resizeHandle.title = 'Resize plugin panel';
    resizeHandle.setAttribute('aria-label', 'Resize plugin panel');
    resizeHandle.textContent = '↘';
    Object.assign(resizeHandle.style, {
      position: 'absolute', right: '3px', bottom: '3px', width: '28px', height: '28px',
      border: '1px solid rgba(255,255,255,.65)', borderRadius: '5px',
      background: '#263238', color: '#fff', cursor: 'nwse-resize', zIndex: '1002',
      fontSize: '18px', lineHeight: '20px', padding: '0', pointerEvents: 'auto',
    });
    container.appendChild(resizeHandle);
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    const onMove = (event: MouseEvent) => {
      if (!resizing) return;
      const width = Math.min(Math.min(900, window.innerWidth - 40), Math.max(360, startWidth + startX - event.clientX));
      const height = Math.min(window.innerHeight - 92, Math.max(420, startHeight + startY - event.clientY));
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
    };
    const onUp = () => { resizing = false; document.body.style.userSelect = ''; };
    const onDown = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startWidth = container.getBoundingClientRect().width;
      startHeight = container.getBoundingClientRect().height;
      document.body.style.userSelect = 'none';
    };
    resizeHandle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    const root = ReactDOM.createRoot(container);
    root.render(
      <React.StrictMode>
        <App hostApp={app} onClose={() => (this as any).deactivate?.(app)} />
      </React.StrictMode>
    );

    (this as any).reactRoot = root;
    (this as any).container = container;
    (this as any).resizeCleanup = () => {
      resizeHandle.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizeHandle.remove();
    };
  },

  // O underline (_) também aqui
  deactivate(_app: any) {
    console.log("❄️ LST Super-Resolution desativado.");
    if ((this as any).reactRoot) {
      (this as any).reactRoot.unmount();
    }
    if ((this as any).resizeCleanup) {
      (this as any).resizeCleanup();
    }
    if ((this as any).container) {
      (this as any).container.remove();
    }
  }
};

export default plugin;

// Only mount the standalone demo during Vite development. GeoLibre owns its
// own #root element; mounting into it from an external plugin causes the host
// application to flash/reload and can prevent the plugin menu from rendering.
if (import.meta.env.DEV && document.getElementById('root')) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
