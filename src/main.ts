import './ui/styles.css';
import { App } from './app/App';
import { MainMenuScreen } from './screens/MainMenuScreen';

declare global {
  interface Window {
    __moonshot?: {
      app: App;
      errors: string[];
      state: () => Record<string, unknown>;
    };
  }
}

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');

const app = new App(root);
app.registerScreen('menu', () => new MainMenuScreen());
app.go('menu');
app.start();

window.__moonshot = { app, errors, state: () => app.debugState() };
