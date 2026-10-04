import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

export const plugin = {
  id: "lst-super-resolution",
name: "LST Super-Resolution (SR2D4)",
  version: "1.0.4",
  
  // O underline (_) avisa o TypeScript para ignorar que a variável não é usada
  activate(app: any) {
    console.log("🔥 LST Super-Resolution ativado no GeoLibre!");
    
    const container = document.createElement('div');
    container.id = 'lst-plugin-container';
    container.style.position = 'absolute';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100vw';
    container.style.height = '100vh';
    container.style.zIndex = '100';
    
    document.body.appendChild(container);

    const root = ReactDOM.createRoot(container);
    root.render(
      <React.StrictMode>
        <App hostApp={app} />
      </React.StrictMode>
    );

    (this as any).reactRoot = root;
    (this as any).container = container;
  },

  // O underline (_) também aqui
  deactivate(_app: any) {
    console.log("❄️ LST Super-Resolution desativado.");
    if ((this as any).reactRoot) {
      (this as any).reactRoot.unmount();
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
