import fs from 'node:fs';

const SOURCE_COMMIT='859eb530c5801577633c2c3ae871d23586edf281';
const SOURCE_SHA256='517d9a42ec48a96f33a626a62e955b8df26dd06d5485438e1f3fe677029135ba';
export const QQ_FACE_CATALOG=JSON.parse(fs.readFileSync(new URL('./qq-face-catalog.json',import.meta.url),'utf8'));
export const SUPPORTED_QQ_FACE_IDS=QQ_FACE_CATALOG.faceIds;
const ids=SUPPORTED_QQ_FACE_IDS;
if(QQ_FACE_CATALOG.schema!==1||QQ_FACE_CATALOG.commit!==SOURCE_COMMIT||QQ_FACE_CATALOG.sha256!==SOURCE_SHA256||
  QQ_FACE_CATALOG.path!=='packages/napcat-core/external/face_config.json'||!Array.isArray(ids)||ids.length!==329||
  ids.some((id,index)=>!Number.isSafeInteger(id)||id<0||(index>0&&ids[index-1]>=id)))throw Error('固定 NapCat 系统表情目录无效');

const supported=new Set(ids);
export function normalizeQQFaceId(value){
  if(!Number.isSafeInteger(value)||!supported.has(value))throw Error('QQ 系统表情 ID 无效或当前版本不支持');
  return value;
}
