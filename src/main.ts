import './ui/styles.css';
import { App } from './app/App';
import { registerPhase } from './app/phases';
import { CruiseScreen } from './screens/CruiseScreen';
import { DesignScreen } from './screens/DesignScreen';
import { FreePlayScreen } from './screens/FreePlayScreen';
import { LaunchScreen } from './screens/LaunchScreen';
import { MainMenuScreen } from './screens/MainMenuScreen';

declare global {
  interface Window {
    __moonshot?: {
      app: App;
      errors: string[];
      state: () => Record<string, unknown>;
      cmd: (cmd: string, arg?: unknown) => unknown;
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
app.registerScreen('freeplay', () => new FreePlayScreen());
registerPhase('design', (m) => new DesignScreen(m));
registerPhase('launch', (m) => new LaunchScreen(m));
registerPhase('cruise', (m) => new CruiseScreen(m));
app.go('menu');
app.start();

window.__moonshot = {
  app,
  errors,
  state: () => app.debugState(),
  cmd: (cmd, arg) => app.currentScreen?.debugCommand?.(cmd, arg),
};
