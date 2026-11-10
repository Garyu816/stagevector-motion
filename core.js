export const VERSION = '1.0.0';
export const G0 = 9.80665;
export const COLUMNS = ['kind','session_id','source','seq','t_us','epoch_ms','wall_ms',
  'event_timestamp_ms','interval_ms','ax_mps2','ay_mps2','az_mps2',
  'agx_mps2','agy_mps2','agz_mps2','rotation_alpha_dps','rotation_beta_dps',
  'rotation_gamma_dps','screen_angle_deg','detail'];
export const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function motionRow(event, meta, seq, now, wall, angle) {
  const a = event.acceleration || {}, g = event.accelerationIncludingGravity || {}, r = event.rotationRate || {};
  const t = Math.round((now - meta.startMono) * 1000);
  return ['SAMPLE',meta.id,meta.source,seq,t,meta.startEpoch+t/1000,wall,
    finite(event.timeStamp),finite(event.interval),finite(a.x),finite(a.y),finite(a.z),
    finite(g.x),finite(g.y),finite(g.z),finite(r.alpha),finite(r.beta),finite(r.gamma),finite(angle),''];
}
export function noteRow(meta, kind, detail, now, wall) {
  const row = Array(COLUMNS.length).fill(null);
  const t = Math.round((now-meta.startMono)*1000);
  Object.assign(row,{0:kind,1:meta.id,2:meta.source,3:meta.count,4:t,5:meta.startEpoch+t/1000,6:wall,19:detail});
  return row;
}
export function csvCell(value) {
  if (value == null || (typeof value==='number' && !Number.isFinite(value))) return '';
  let s=String(value);
  // Numeric fields remain numbers. Protect any future free-text CSV cell.
  if(typeof value==='string' && /^[=+\-@\t\r]/.test(s)) s="'"+s;
  return /[",\r\n]/.test(s) ? '"'+s.replaceAll('"','""')+'"' : s;
}
export const csvLine = row => row.map(csvCell).join(',')+'\r\n';
export function exportName(meta) {
  return `SV_${meta.source}_${new Date(meta.startEpoch).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}_${meta.id.slice(-8)}.csv`;
}
export const validMotion = row => row.slice(9,18).some(v=>v!==null);
