import { navMask } from '~/utils/nav-geometry';

export default defineNuxtPlugin(() => {
  const selector = '.ik-header-tab,.ik-stream-tab,.ik-mobile-nav__item';
  const observed = new Set<HTMLElement>();
  function update(el: HTMLElement) {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const siblings = [...el.parentElement!.children].filter(e => e.matches(selector));
    const position = siblings[0] === el ? 'first' : siblings.at(-1) === el ? 'last' : 'middle';
    el.style.setProperty('--ik-plate-extra', position === 'middle' ? '6px' : '0px');
    el.style.setProperty('--ik-plate-fill', navMask(width, height, position));
    el.style.setProperty('--ik-plate-outline', navMask(width, height, position, true));
  }
  const resize = new ResizeObserver(entries => entries.forEach(e => update(e.target as HTMLElement)));
  let scheduled = false;
  function scan() {
    scheduled = false;
    for (const el of observed) if (!el.isConnected) { resize.unobserve(el); observed.delete(el); }
    document.querySelectorAll<HTMLElement>(selector).forEach(el => {
      if (!observed.has(el)) { observed.add(el); resize.observe(el); }
      update(el);
    });
  }
  const mutations = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(scan); } });
  mutations.observe(document.body, { childList: true, subtree: true });
  scan();
});
