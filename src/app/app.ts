import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { LOVE_STORY } from './story.config';
import { UniverseRenderer } from './universe-renderer';

/** What the film needs from a renderer: the 3D one (WebGL) or the 2D fallback (Canvas). */
interface UniverseView {
  reducedMotion: boolean;
  resize(): void;
  move(x: number, y: number): void;
  render(time: number, scene: number, local: number, holding: boolean, connection: number): void;
  dispose?(): void;
}
import { GentleSoundtrack } from './gentle-soundtrack';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements AfterViewInit, OnDestroy {
  readonly story = LOVE_STORY;
  readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly film = viewChild.required<ElementRef<HTMLElement>>('film');
  readonly scene = signal(0);
  readonly paused = signal(false);
  readonly holding = signal(false);
  readonly sound = signal(false);
  readonly soundError = signal(false);
  readonly letterOpen = signal(false);
  readonly unsupported = signal(false);
  readonly reducedMotion = signal(false);
  readonly connected = signal(false);
  readonly caption = signal('');
  readonly progress = signal(0);
  readonly started = computed(() => this.scene() > 0);
  private renderer?: UniverseView;
  private destroyed = false;
  private frame = 0;
  private clock = 0;
  private lastTick = 0;
  private localTime = 0;
  private join = 0;
  private pointerStart = 0;
  private pointerActive = false;
  private readonly soundtrack = new GentleSoundtrack();
  // A trilha acompanha o filme: cada cena começa no trecho certo da música.
  private readonly soundtrackSync = effect(() => this.soundtrack.setScene(this.scene()));
  readonly soundLoading = signal(false);
  private observer?: ResizeObserver;
  private readonly motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly boundaries = [0, 12, 25, 36, 52, 66];
  private readonly motionChange = () => {
    this.reducedMotion.set(this.motionPreference.matches);
    if (this.renderer) this.renderer.reducedMotion = this.reducedMotion();
  };
  private readonly visibilityChange = () => {
    if (document.hidden) {
      this.soundtrack.pause(true);
      if (this.started()) this.paused.set(true);
    } else if (!this.paused()) {
      this.soundtrack.pause(false);
    }
  };

  ngAfterViewInit(): void {
    this.motionPreference.addEventListener('change', this.motionChange);
    this.observer = new ResizeObserver(() => this.renderer?.resize());
    this.observer.observe(this.canvas().nativeElement);
    document.addEventListener('visibilitychange', this.visibilityChange);
    this.frame = requestAnimationFrame(this.tick);
    void this.createRenderer();
  }
  /** Loads the cinematic 3D universe (WebGL) on demand; falls back to the 2D canvas version. */
  private async createRenderer(): Promise<void> {
    const canvas = this.canvas().nativeElement;
    try {
      const { CinematicUniverse } = await import('./cinematic-universe');
      if (this.destroyed) return;
      this.renderer = new CinematicUniverse(canvas);
    } catch (error) {
      console.warn('Universo 3D indisponível, usando a versão 2D.', error);
      try {
        this.renderer = new UniverseRenderer(canvas);
      } catch {
        this.unsupported.set(true);
        return;
      }
    }
    this.motionChange();
  }
  private readonly tick = (stamp: number) => {
    const dt = this.lastTick ? Math.min((stamp - this.lastTick) / 1000, 0.05) : 0;
    this.lastTick = stamp;
    if (!this.paused()) {
      this.clock += dt;
      if (this.started() && this.scene() < 6) {
        this.localTime += dt;
        if (this.scene() === 4) {
          this.join = Math.min(1, this.join + dt * (this.holding() ? 0.6 : 0.08));
          if (this.join >= 1 && !this.connected()) {
            this.connected.set(true);
            this.localTime = Math.max(this.localTime, 14);
          }
        }
        const duration = [0, 12, 13, 11, 16, 14][this.scene()];
        if (this.localTime >= duration) this.advance();
        const elapsed = this.boundaries[this.scene() - 1] + this.localTime;
        this.progress.set(Math.min(100, (elapsed / 66) * 100));
        this.updateCaption();
      }
    }
    this.renderer?.render(this.clock, this.scene(), this.localTime, this.holding(), this.join);
    this.frame = requestAnimationFrame(this.tick);
  };
  start(): void {
    this.scene.set(1);
    this.localTime = 0;
    this.paused.set(false);
    this.soundtrack.pause(false);
    // A trilha liga sozinha ao começar o filme (o clique conta como gesto para o navegador tocar áudio).
    if (!this.sound() && !this.soundError()) void this.toggleSound();
    this.film().nativeElement.focus({ preventScroll: true });
    this.updateCaption();
  }
  advance(): void {
    if (this.scene() === 0) {
      this.start();
      return;
    }
    if (this.scene() >= 6) return;
    this.scene.update((value) => value + 1);
    this.localTime = 0;
    this.holding.set(false);
    this.pointerActive = false;
    if (this.scene() === 5) {
      this.join = 1;
      this.connected.set(true);
    }
    if (this.scene() === 6) this.progress.set(100);
    this.updateCaption();
  }
  private updateCaption(): void {
    const local = this.localTime;
    const captions: Record<number, string> = {
      1:
        local < 5
          ? 'O universo tem bilhões de estrelas.'
          : local < 9
            ? 'Bilhões de caminhos possíveis.'
            : 'E um senso de humor bem peculiar.',
      2:
        local < 5
          ? 'De um lado, eu.'
          : local < 9
            ? 'Do outro, você.'
            : 'Dois caminhos. A mesma vontade de se encontrar.',
      3:
        local < 4
          ? 'O cupido tentou dar uma força.'
          : local < 8
            ? 'Mas, pelo visto, fez o curso por correspondência.'
            : 'Tudo bem. A gente resolve daqui.',
      4: this.connected()
        ? 'Isso. Bem aqui.'
        : local < 6
          ? 'No fim, o universo só precisava de uma ajudinha.'
          : 'Algumas distâncias existem só até o primeiro passo.',
      5:
        local < 5
          ? 'E no meio de tanta imensidão…'
          : local < 10
            ? 'eu encontrei o meu lugar.'
            : 'Não era um lugar. Era você.',
      6: this.story.invitation,
    };
    this.caption.set(captions[this.scene()] ?? '');
  }
  pointerDown(event: PointerEvent): void {
    if (!this.started() || this.scene() >= 5) return;
    this.pointerActive = true;
    this.pointerStart = event.clientX;
    this.holding.set(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  pointerMove(event: PointerEvent): void {
    this.renderer?.move(event.clientX, event.clientY);
    if (this.pointerActive && this.scene() === 4) {
      this.join = Math.min(
        1,
        this.join + Math.abs(event.clientX - this.pointerStart) / Math.max(1, innerWidth * 0.5),
      );
      this.pointerStart = event.clientX;
    }
  }
  pointerUp(): void {
    this.pointerActive = false;
    this.holding.set(false);
  }
  togglePause(): void {
    this.paused.update((value) => !value);
    this.soundtrack.pause(this.paused());
  }
  keyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLButtonElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!this.started()) this.start();
      else this.togglePause();
    }
    if (event.code === 'ArrowRight' && this.started()) {
      event.preventDefault();
      this.advance();
    }
    if (event.code === 'Enter' && this.scene() === 4) {
      this.join = 1;
      this.connected.set(true);
    }
  }
  async toggleSound(): Promise<void> {
    if (this.soundLoading()) return;
    if (this.sound()) {
      this.soundtrack.stop();
      this.sound.set(false);
      return;
    }
    this.soundLoading.set(true);
    try {
      this.soundtrack.pause(this.paused());
      await this.soundtrack.play();
      this.sound.set(true);
      this.soundError.set(false);
    } catch {
      this.soundError.set(true);
    } finally {
      this.soundLoading.set(false);
    }
  }
  restart(): void {
    this.scene.set(0);
    this.localTime = 0;
    this.join = 0;
    this.connected.set(false);
    this.progress.set(0);
    this.caption.set('');
    this.letterOpen.set(false);
    this.paused.set(false);
    this.soundtrack.pause(false);
    this.pointerUp();
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.renderer?.dispose?.();
    this.observer?.disconnect();
    this.motionPreference.removeEventListener('change', this.motionChange);
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.soundtrack.destroy();
  }
}
