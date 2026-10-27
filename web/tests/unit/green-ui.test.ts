import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const css=readFileSync(`${process.cwd()}/app/assets/styles/reference-alignment.css`,'utf8');
const home=readFileSync(`${process.cwd()}/app/pages/index.vue`,'utf8');
it('keeps the approved large banner through the shared component',()=>{expect(home).toContain('<TerminalMasthead />');const banner=readFileSync(`${process.cwd()}/app/components/TerminalMasthead.vue`,'utf8');expect(banner).toContain('class="ik-terminal-masthead"');expect(banner).toContain('/images/zzz.webp');expect(banner).toContain('ik-terminal-masthead__art');});
it('reuses the homepage banner and card material in the commission editor',()=>{const create=readFileSync(`${process.cwd()}/app/pages/create.vue`,'utf8');expect(create).toContain('<TerminalMasthead');expect(create).toContain('var(--ik-post-card-inner-bg)');expect(create).not.toContain('commission-masthead');});
it('uses the green accent rather than the reference gray selection',()=>{expect(css).toContain('--ik-primary:#d7fa00');expect(css).not.toContain('background:#e5e5e5');});
it('animates the independent backing plate',()=>{expect(css).toContain('ik-stream-tab::before');expect(css).toContain('@keyframes ik-nav-plate-breathe');expect(css).not.toContain('--ik-bubble-start');expect(css).toContain('.ik-stream-tab > *{position:relative;z-index:1;transform:none}');});
it('honors reduced motion',()=>{expect(css).toContain('@media(prefers-reduced-motion:reduce)');expect(css).toContain('animation:none!important');});
it('shares one capsule instead of outlining every idle tab',()=>{expect(css).toContain(".ik-stream-tabs{gap:0;padding:2px;background:#080808");expect(css).toContain('border-radius:999px');expect(css).toContain('border:2px solid transparent');});
it('uses transparent gray outlines for hover, not a green fill',()=>{
 expect(css).toContain('background:transparent;border-color:#858585;animation:none;inset:-2px -3px;transform:none');
 expect(css).toContain('inset:-2px -3px;border-color:#858585;transform:none');
});
it('keeps the SVG viewport unclipped and has no plate shadow box',()=>{expect(css).toContain('border-radius:999px;box-sizing:border-box;background:transparent');expect(css).toContain('background:transparent;box-shadow:none;transform:none');});

it("keeps hover contours static and reserves motion for selected green plates",()=>{expect(css).not.toContain("ik-outline-plate-breathe");expect(css).toContain(".ik-header-tab.is-active .ik-tab-highlight");});
it('gives desktop Web a separate full-width navigation shell',()=>{expect(css).toContain('@media(min-width:1025px)');expect(css).toContain('grid-template-rows:60px 52px');expect(css).toContain('grid-column:1/-1;grid-row:2');expect(css).toContain('body #__nuxt .ik-mobile-nav{display:none}');});

it('breathes both navigation rows with visible proportional width and height changes',()=>{expect(css).toContain('0%,100%{inset:0;');expect(css).toContain('50%{inset:-4%');expect(css).not.toContain('skewX');const header=readFileSync(`${process.cwd()}/app/components/AppHeader.vue`,'utf8');expect(header).not.toContain('<svg class="ik-tab-highlight');});

it('shares one continuous animation across desktop feed and H5',()=>{expect(css.match(/animation:ik-nav-plate-breathe 800ms ease-in-out infinite/g)).toHaveLength(3);expect(css).toContain('animation-play-state:running!important');expect(css).toContain('.ik-mobile-nav__item .ik-mobile-nav__inner{transform:none;transition:none}');});
it('gives H5 a horizontal capsule track instead of a tall stacked footer bubble',()=>{expect(css).toContain('bottom:calc(8px + env(safe-area-inset-bottom,0px));height:46px');expect(css).toContain('.ik-mobile-nav__item .ik-mobile-nav__inner{flex-direction:row;gap:4px;transform:none;transition:none}');expect(css).toContain('.ik-mobile-nav__item{min-width:0;height:40px;border-radius:999px}');});


it('uses the same measured rounded-slant geometry for fill and outline',()=>{expect(css).toContain('mask-image:var(--ik-plate-fill)');expect(css).toContain('mask-image:var(--ik-plate-outline)');expect(css).toContain('clip-path:none');expect(css).not.toContain('clip-path:var(--ik-plate-clip)');});

it('removes the old feed selection layer beneath the new plate',()=>{const art=readFileSync(`${process.cwd()}/app/assets/styles/interknot-art-direction.css`,'utf8');const nav=readFileSync(`${process.cwd()}/app/components/HomeFeedNavigation.vue`,'utf8');expect(art).not.toContain(".ik-stream-tab[data-state='active'] { background:");expect(nav).not.toContain('<TabsIndicator');expect(css).toContain('.ik-stream-tab:is([data-state=active],[aria-selected=true]){background:transparent;border:0;box-shadow:none}');});

it('widens middle plate geometry without moving text or changing the breathing cycle',()=>{const plugin=readFileSync(`${process.cwd()}/app/plugins/nav-geometry.client.ts`,'utf8');expect(plugin).toContain("position === 'middle' ? '6px' : '0px'");expect(css).toContain('margin-inline:calc(0px - var(--ik-plate-extra,0px))');});
