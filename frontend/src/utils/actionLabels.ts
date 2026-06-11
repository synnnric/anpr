import type { Lang } from '../i18n/translations';

/**
 * Human-readable labels for operation_log action codes.
 * Keyed by the raw action string logged by the backend.
 * Anything not listed falls back to a prettified version of the raw code.
 */
const ACTION_LABELS: Record<string, { id: string; en: string }> = {
  // S300 device control
  come:                  { id: 'Panggil kendaraan', en: 'Vehicle come' },
  come_vip_bypass:       { id: 'Lewati VIP', en: 'VIP bypass' },
  capture:               { id: 'Ambil gambar', en: 'Capture' },
  leave:                 { id: 'Kendaraan keluar', en: 'Vehicle leave' },
  auto_leave:            { id: 'Keluar otomatis', en: 'Auto leave' },
  read_work_status:      { id: 'Baca status kerja', en: 'Read work status' },
  emergency_stop:        { id: 'Henti darurat', en: 'Emergency stop' },
  manual_reset:          { id: 'Reset manual', en: 'Manual reset' },
  reset_watchdog:        { id: 'Reset watchdog', en: 'Reset watchdog' },
  audio_prompt:          { id: 'Putar audio', en: 'Audio prompt' },
  send_backup_audio:     { id: 'Audio cadangan', en: 'Backup audio' },
  video_playback:        { id: 'Putar ulang video', en: 'Video playback' },

  // Decision flow
  auto_decision:         { id: 'Keputusan otomatis', en: 'Auto decision' },
  whitelist_enqueue_add: { id: 'Tambah whitelist', en: 'Whitelist add' },
  whitelist_skipped:     { id: 'Whitelist dilewati', en: 'Whitelist skipped' },

  // Road blocker
  open_blocker:          { id: 'Buka palang', en: 'Open blocker' },
  open_blocker_skipped:  { id: 'Buka palang dilewati', en: 'Open blocker skipped' },
  blocker_close:         { id: 'Tutup palang', en: 'Close blocker' },
  up:                    { id: 'Palang naik', en: 'Blocker up' },
  down:                  { id: 'Palang turun', en: 'Blocker down' },

  // Configuration (manual)
  'channel.create':      { id: 'Buat channel', en: 'Create channel' },
  'channel.update':      { id: 'Ubah channel', en: 'Update channel' },
  'channel.delete':      { id: 'Hapus channel', en: 'Delete channel' },
  'vip.create':          { id: 'Tambah VIP', en: 'Add VIP' },
  'vip.update':          { id: 'Ubah VIP', en: 'Update VIP' },
  'vip.delete':          { id: 'Hapus VIP', en: 'Delete VIP' },
  'settings.update':     { id: 'Ubah pengaturan', en: 'Update settings' },
  'admin.reset_data':    { id: 'Bersihkan data', en: 'Clear data' },

  // Auth
  'auth.sso_login':      { id: 'Masuk SSO', en: 'SSO login' },
};

/** Prettify an unknown raw action code: "open_blocker_skipped" -> "Open blocker skipped". */
function prettify(raw: string): string {
  const text = raw.replace(/[._]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Readable label for an action code in the given language. */
export function actionLabel(action: string, lang: Lang): string {
  const entry = ACTION_LABELS[action];
  if (entry) return entry[lang] ?? entry.en;
  return prettify(action);
}
