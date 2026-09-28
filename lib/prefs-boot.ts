// Runs before the page paints (inlined by the root layout) so the saved language, direction
// and theme apply immediately instead of flashing the defaults. Keys match lib/prefs.ts.
export const prefsBootScript = `(function(){try{var l=localStorage.getItem("jmr-lang")==="ar"?"ar":"en";var s=localStorage.getItem("jmr-theme");var t=s==="dark"||s==="light"?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var r=document.documentElement;r.lang=l;r.dir=l==="ar"?"rtl":"ltr";r.dataset.theme=t;}catch(e){}})();`;
