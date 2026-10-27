interface SiteSettings {siteTitle:string;siteIcon:string;siteBackground:string;backgroundColor:string}
export default defineNuxtPlugin(async()=>{
  const site=useState<SiteSettings>('site-settings',()=>({siteTitle:'绳网',siteIcon:'/icon/favicon-32x32.png',siteBackground:'',backgroundColor:'#121212'}));
  try{site.value=await $fetch<SiteSettings>('/v1/site',{timeout:5000});}catch{/* Keep defaults during network failures. */}
  useHead(()=>({title:site.value.siteTitle,titleTemplate:()=>site.value.siteTitle,link:[{rel:'icon',href:site.value.siteIcon||'/icon/favicon-32x32.png',key:'site-icon'}]}));
  watch(site,v=>{document.documentElement.style.setProperty('--site-bg-color',v.backgroundColor||'#121212');document.documentElement.style.setProperty('--site-bg-image',v.siteBackground?`url(${JSON.stringify(v.siteBackground)})`:'none');},{deep:true,immediate:true});
});
