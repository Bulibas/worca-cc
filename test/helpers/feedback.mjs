// Read feedback.mjs output from a booted app DOM (#555).
export const toastTitles = (doc) => [...doc.querySelectorAll('#toasts > .toast .tt')].map((n) => n.textContent);
export const lastToast = (doc) => {
  const all = doc.querySelectorAll('#toasts > .toast');
  const t = all[all.length - 1];
  return t ? { tone: [...t.classList].find((c) => c !== 'toast'), title: t.querySelector('.tt')?.textContent || '',
    detail: t.querySelector('.td')?.textContent || '', action: t.querySelector('.toast-act')?.textContent || '' } : null;
};
export const fieldErrorText = (input) => {
  const id = (input.getAttribute('aria-describedby') || '').split(/\s+/).find((x) => x.startsWith('fe-'));
  return id ? input.ownerDocument.getElementById(id)?.textContent || '' : '';
};
export const cardAlertOf = (card) => {
  const a = card?.querySelector('.card-alert');
  return a ? { title: a.querySelector('.ca-title')?.textContent || '', detail: a.querySelector('.ca-detail')?.textContent || '' } : null;
};
// (v2) Make a control dirty the way a user does: set the value, then fire a BUBBLING input
// and change event. A non-bubbling `new Event('change')` never reaches the card's tracker.
export const edit = (window, node, value) => {
  if (node.type === 'checkbox' || node.type === 'radio') node.checked = value; else node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
  node.dispatchEvent(new window.Event('change', { bubbles: true }));
};
