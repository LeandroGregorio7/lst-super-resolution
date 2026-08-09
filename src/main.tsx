import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 1. Exportação oficial do Plugin para o GeoLibre
export const plugin = {
  id: "lst-super-resolution",
  name: "LST Super-Resolution (SR2D4)",
  version: "1.0.0",
  
  // Função que o GeoLibre chama quando o utilizador ATIVA o plugin
  activate(app: any) {
    console.log("🔥 LST Super-Resolution ativado no GeoLibre!");
    
    // Cria um contentor invisível para injetar a nossa app
    const container = document.createElement('div');
    container.id = 'lst-plugin-container';
    container.style.position = 'absolute';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100vw';
    container.style.height = '100vh';
    container.style.zIndex = '9999'; // Fica por cima do mapa original
    
    document.body.appendChild(container);

    // Arranca o nosso React dentro desse contentor
    const root = ReactDOM.createRoot(container);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    // Guarda referências para podermos limpar depois
    (this as any).reactRoot = root;
    (this as any).container = container;
  },

  // Função que o GeoLibre chama quando o utilizador DESATIVA o plugin
  deactivate(app: any) {
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

// 2. Fallback para Desenvolvimento Local
// Isto garante que o "npm run dev" continua a funcionar perfeitamente no seu PC!
if (document.getElementById('root')) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}