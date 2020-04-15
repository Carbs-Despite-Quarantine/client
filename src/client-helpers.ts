export function getURLParam(name: string): string | null {
  let results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
  return results && results[1] || null;
}