import './style.css';
import { Game } from './game/Game';

/** If anything throws, show it on screen instead of silently freezing. */
function showCrash(message: string): void {
  console.error(message);
  document.getElementById('crash-text')!.textContent = message;
  document.getElementById('crash')!.classList.remove('hidden');
  document.exitPointerLock?.();
}
window.addEventListener('error', (e) => showCrash(`${e.message}\n${e.error?.stack ?? ''}`));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string } | undefined;
  // Pointer-lock refusals are normal (e.g. clicking Resume right after Esc); handled elsewhere.
  if (r?.message?.toLowerCase().includes('pointer lock') || String(e.reason).includes('pointer lock')) return;
  showCrash(`${r?.message ?? String(e.reason)}\n${r?.stack ?? ''}`);
});

const game = new Game(document.getElementById('app')!);
game.start();

// Dev only: lets test scripts and the browser console poke at the game.
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
