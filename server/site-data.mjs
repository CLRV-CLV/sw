export const profileDefaults = { nickname:'', bio:'', avatarUrl:'', level:1, exp:0, denny:0, polychrome:0, hidden:false };
export function safeImage(value) {
  if (typeof value !== 'string' || value.length>2000) return false;
  if (!value) return true;
  if (/^\/(?!\/)[^\s\\]*$/.test(value)) return true;
  try { const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password; } catch {return false;}
}
export function validateProfile(p) {
  for(const [key,value] of Object.entries(p)) {
    if (!(key in profileDefaults)) return false;
    if (['level','exp','denny','polychrome'].includes(key) && (!Number.isSafeInteger(value)||value<(key==='level'?1:0)||value>(key==='level'?1000:1e12))) return false;
    if (key==='nickname'&&(typeof value!=='string'||value.length>40)) return false;
    if (key==='bio'&&(typeof value!=='string'||value.length>1000)) return false;
    if (key==='avatarUrl'&&!safeImage(value)) return false;
    if (key==='hidden'&&typeof value!=='boolean') return false;
  } return true;
}
export function createProfiles(db) {
  db.exec('CREATE TABLE IF NOT EXISTS user_profiles(userId TEXT PRIMARY KEY,data TEXT)');
  return {
    get(id) {const row=db.prepare('SELECT data FROM user_profiles WHERE userId=?').get(id);return {...profileDefaults,...(row?JSON.parse(row.data):{})};},
    set(id,patch) {const data={...this.get(id),...patch};db.prepare('INSERT OR REPLACE INTO user_profiles VALUES(?,?)').run(id,JSON.stringify(data));return data;},
  };
}
