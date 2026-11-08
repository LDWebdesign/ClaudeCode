import './styles/main.css';
import { App } from './app';

const root = document.getElementById('app');
if (root) {
  const app = new App(root);
  app.boot().catch((err) => {
    console.error(err);
    root.textContent = 'Residual could not start in this browser.';
  });
}
