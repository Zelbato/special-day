interface Star {
  x: number;
  y: number;
  z: number;
  radius: number;
  warmth: number;
}
interface Particle {
  x: number;
  y: number;
  z: number;
  size: number;
  hue: number;
}

/** Procedural canvas artwork: no remote media, textures or rendering dependency. */
export class UniverseRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly stars: Star[];
  private readonly heart: Particle[];
  private width = 1;
  private height = 1;
  private ratio = 1;
  private lastTime = 0;
  private travel = 0;
  private pointer = { x: 0, y: 0 };
  private readonly glow: HTMLCanvasElement;
  reducedMotion = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D indisponível');
    this.context = context;
    this.stars = Array.from({ length: 650 }, () => ({
      x: (Math.random() - 0.5) * 2400,
      y: (Math.random() - 0.5) * 2400,
      z: Math.random() * 2000,
      radius: Math.random() * 1.3 + 0.2,
      warmth: Math.random(),
    }));
    this.heart = Array.from({ length: 1600 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const fill = Math.sqrt(Math.random());
      return {
        x: 16 * Math.sin(angle) ** 3 * fill,
        y:
          -(
            13 * Math.cos(angle) -
            5 * Math.cos(2 * angle) -
            2 * Math.cos(3 * angle) -
            Math.cos(4 * angle)
          ) * fill,
        z: (Math.random() - 0.5) * 8 * (1 - fill),
        size: Math.random() * 1.4 + 0.3,
        hue: Math.random(),
      };
    });
    this.glow = document.createElement('canvas');
    this.glow.width = this.glow.height = 128;
    const glowContext = this.glow.getContext('2d');
    if (glowContext) {
      const gradient = glowContext.createRadialGradient(64, 64, 0, 64, 64, 64);
      gradient.addColorStop(0, '#fff8e8');
      gradient.addColorStop(0.08, '#ffdec3cc');
      gradient.addColorStop(0.22, '#e7a76a55');
      gradient.addColorStop(1, '#c9744200');
      glowContext.fillStyle = gradient;
      glowContext.fillRect(0, 0, 128, 128);
    }
    this.resize();
  }
  resize(): void {
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = this.width * this.ratio;
    this.canvas.height = this.height * this.ratio;
    this.context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
  }
  move(x: number, y: number): void {
    this.pointer = { x: x / this.width - 0.5, y: y / this.height - 0.5 };
  }
  render(time: number, scene: number, local: number, holding: boolean, connection: number): void {
    const ctx = this.context;
    const dt = Math.min(time - this.lastTime, 0.05);
    this.lastTime = time;
    const t = this.reducedMotion ? 2 : time;
    const warp = scene === 1 && !this.reducedMotion;
    this.travel += dt * (warp ? (holding ? 1300 : 430) : this.reducedMotion ? 0 : 17);
    const cx = this.width / 2,
      cy = this.height * 0.44;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#05070e';
    ctx.fillRect(0, 0, this.width, this.height);
    this.nebula(cx * 0.15, cy * 1.2, Math.max(this.width, this.height) * 0.65, '#302647', 0.25);
    this.nebula(this.width * 0.95, this.height * 0.3, this.width * 0.65, '#785037', 0.16);
    this.nebula(
      cx,
      cy,
      Math.min(this.width, this.height) * 0.7,
      scene >= 5 ? '#8c4437' : '#344655',
      scene >= 5 ? 0.24 : 0.1,
    );
    const focal = Math.min(this.width, this.height) * 0.8;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const star of this.stars) {
      const z = ((((star.z - this.travel) % 2000) + 2000) % 2000) + 1;
      const scale = focal / z;
      const x = star.x * scale + cx - this.pointer.x * 16;
      const y = star.y * scale + cy - this.pointer.y * 16;
      if (x < -20 || x > this.width + 20 || y < -20 || y > this.height + 20) continue;
      const alpha = Math.min(1, (2000 - z) / 1400) * (0.65 + Math.sin(t * 0.5 + star.x) * 0.2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = star.warmth > 0.65 ? '#d7b89c' : '#bfcede';
      if (warp) {
        const tail = holding ? 0.17 : 0.06;
        ctx.strokeStyle = star.warmth > 0.65 ? '#d7b89c' : '#afc4e5';
        ctx.lineWidth = Math.max(0.5, star.radius * scale);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (x - cx) * tail, y + (y - cy) * tail);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, Math.min(2, Math.max(0.3, star.radius * scale)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    if (scene === 0) this.blackHole(cx, cy, Math.min(this.width * 0.3, this.height * 0.31), t);
    if (scene === 1) {
      const opening = Math.max(0, 1 - local / 4);
      if (opening > 0) {
        ctx.save();
        ctx.globalAlpha = opening;
        this.blackHole(
          cx,
          cy,
          Math.min(this.width * 0.3, this.height * 0.31) * (1 + local * 0.7),
          t,
        );
        ctx.restore();
      }
      this.glowingOrb(cx, cy, 3, '#eff7ff', 0.5 + Math.sin(t) * 0.15);
    }
    if (scene === 2 || scene === 3 || scene === 4) this.orbits(cx, cy, t, scene, local, connection);
    if (scene >= 5) this.heartGalaxy(cx, cy - 15, t, local, scene === 6);
    const vignette = ctx.createRadialGradient(
      cx,
      cy,
      this.width * 0.15,
      cx,
      cy,
      Math.max(this.width, this.height) * 0.75,
    );
    vignette.addColorStop(0, '#00000000');
    vignette.addColorStop(1, '#000000bb');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.width, this.height);
  }
  private nebula(x: number, y: number, radius: number, color: string, alpha: number): void {
    const ctx = this.context;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, '#05070e00');
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }
  private blackHole(x: number, y: number, radius: number, t: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.27);
    ctx.globalCompositeOperation = 'screen';
    for (let i = 22; i > 0; i--) {
      ctx.beginPath();
      ctx.ellipse(
        0,
        0,
        radius * (1.08 + i * 0.014),
        radius * (0.27 + i * 0.004),
        0,
        0,
        Math.PI * 2,
      );
      ctx.strokeStyle = `rgba(224,162,102,${0.018 + (22 - i) * 0.001})`;
      ctx.lineWidth = i * 0.7;
      ctx.stroke();
    }
    for (let i = 0; i < 80; i++) {
      const r = radius * (1.01 + i * 0.01);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.26, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(242,${185 + (i % 25)},${125 + (i % 50)},${0.06 + (Math.sin(i * 2.4 + t * 0.5) + 1) * 0.035})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    const sphere = ctx.createRadialGradient(
      -radius * 0.1,
      -radius * 0.1,
      radius * 0.65,
      0,
      0,
      radius,
    );
    sphere.addColorStop(0, '#020308');
    sphere.addColorStop(0.94, '#03040a');
    sphere.addColorStop(1, '#e0af7833');
    ctx.fillStyle = sphere;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = '#edc090';
    ctx.shadowBlur = 20;
    ctx.strokeStyle = '#e7b17b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.73, Math.PI * 1.02, Math.PI * 1.98);
    ctx.stroke();
    ctx.shadowBlur = 0;
    for (let i = 0; i < 34; i++) {
      const r = radius * (1.01 + i * 0.022);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.26, 0, 0, Math.PI);
      ctx.strokeStyle = `rgba(255,211,156,${0.16 - i * 0.0035})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    for (let i = 0; i < 55; i++) {
      const a = i * 2.399 + t * 0.025;
      const r = radius * (1.08 + (i % 13) * 0.055);
      this.context.globalAlpha = 0.3 + Math.sin(t + i) * 0.2;
      this.context.drawImage(this.glow, Math.cos(a) * r - 4, Math.sin(a) * r * 0.26 - 4, 8, 8);
    }
    ctx.restore();
  }
  private glowingOrb(x: number, y: number, size: number, color: string, alpha = 1): void {
    const ctx = this.context;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.glow, x - size * 13, y - size * 13, size * 26, size * 26);
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  private orbits(
    cx: number,
    cy: number,
    t: number,
    scene: number,
    local: number,
    connection: number,
  ): void {
    const ctx = this.context;
    const r = Math.min(this.width * 0.34, this.height * 0.3);
    const a = scene === 4 ? -0.3 : t * 0.16;
    const converge = scene === 4 ? 1 - connection * 0.92 : 1;
    const x1 = cx - Math.cos(a) * r * converge,
      y1 = cy - Math.sin(a) * r * 0.45;
    const x2 = cx + Math.cos(a) * r * converge,
      y2 = cy + Math.sin(a) * r * 0.45;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.3);
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `rgba(190,162,132,${0.16 - i * 0.04})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.ellipse(0, 0, r + i * 17, r * 0.45 + i * 12, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    for (let i = 0; i < 80; i++) {
      const trail = i * 0.012;
      const b = a - trail;
      const opacity = (1 - i / 80) * 0.5;
      ctx.fillStyle = `rgba(239,195,140,${opacity})`;
      ctx.beginPath();
      ctx.arc(cx - Math.cos(b) * r * converge, cy - Math.sin(b) * r * 0.45, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(183,203,245,${opacity})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(b) * r * converge, cy + Math.sin(b) * r * 0.45, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (scene === 4) {
      ctx.setLineDash([2, 7]);
      ctx.strokeStyle = `rgba(239,214,183,${0.2 + connection * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (connection > 0.05) this.glowingOrb(cx, cy, connection * 6, '#ffebd2', connection);
    }
    this.glowingOrb(x1, y1, 4, '#ffddb4');
    this.glowingOrb(x2, y2, 4, '#d0dfff');
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.letterSpacing = '3px';
    ctx.fillStyle = '#d9bc96';
    ctx.fillText('EU', x1, y1 + 40);
    ctx.fillStyle = '#bdcbe5';
    ctx.fillText('VOCÊ', x2, y2 + 40);
    ctx.letterSpacing = '0px';
    if (scene === 3) {
      const flight = this.reducedMotion ? 0.8 : Math.min(1, local / 3);
      const mx = cx - r + flight * (r * 2.8),
        my = cy - r * 0.9 + Math.sin(flight * Math.PI) * r * 0.35;
      ctx.strokeStyle = '#efc69288';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx - 80, my - 18);
      ctx.lineTo(mx, my);
      ctx.stroke();
      this.glowingOrb(mx, my, 3, '#ffce93');
      if (local > 3) {
        ctx.fillStyle = '#bba98e';
        ctx.font = 'italic 12px Georgia';
        ctx.fillText('errou. de novo.', cx, cy - r * 0.8);
      }
    }
  }
  private heartGalaxy(cx: number, cy: number, t: number, local: number, final: boolean): void {
    const ctx = this.context;
    const scale = Math.min(this.width / 45, this.height / 52);
    const reveal = final || this.reducedMotion ? 1 : Math.min(1, local / 4);
    const turn = Math.sin(t * 0.18) * 0.2;
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(t * 1.4) * 0.018;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    this.nebula(cx, cy, scale * 22, '#8e4e35', 0.2);
    for (let i = 0; i < this.heart.length; i++) {
      const particle = this.heart[i];
      const spread = (1 - reveal) * 12;
      const x = (particle.x * Math.cos(turn) + particle.z * Math.sin(turn)) * scale * pulse;
      const y = particle.y * scale * pulse;
      const dx = cx + x + Math.sin(i * 7.5) * spread * 20;
      const dy = cy + y + Math.cos(i * 4.5) * spread * 20;
      ctx.globalAlpha = (0.35 + Math.sin(t + i) * 0.2) * reveal;
      ctx.fillStyle = particle.hue > 0.45 ? '#f8d6a2' : '#cc8581';
      ctx.beginPath();
      ctx.arc(dx, dy, particle.size * (this.width < 600 ? 0.7 : 1), 0, Math.PI * 2);
      ctx.fill();
      if (i % 20 === 0) {
        ctx.globalAlpha = 0.4 * reveal;
        ctx.drawImage(this.glow, dx - 13, dy - 13, 26, 26);
      }
    }
    ctx.restore();
    if (!final && local < 1 && !this.reducedMotion) {
      ctx.fillStyle = `rgba(255,239,218,${(1 - local) * 0.5})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }
}
