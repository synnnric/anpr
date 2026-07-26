<?php
declare(strict_types=1);

// ===== Bootstrap =====
// APP_ENV (Apache SetEnv / process env) selects config/config.{env}.php,
// e.g. APP_ENV=prod -> config.prod.php. Unset or missing file falls back
// to config/config.php, so existing single-config machines keep working.
$appEnv = $_SERVER['APP_ENV'] ?? getenv('APP_ENV');
$envConfig = $appEnv ? __DIR__ . '/../config/config.' . basename($appEnv) . '.php' : null;
$GLOBALS['APP_CONFIG'] = require ($envConfig && is_file($envConfig) ? $envConfig : __DIR__ . '/../config/config.php');
date_default_timezone_set($GLOBALS['APP_CONFIG']['app']['timezone']);

require __DIR__ . '/../src/Core/Autoloader.php';

use App\Core\Request;
use App\Core\Router;
use App\Core\Response;
use App\Controllers\InboundController;
use App\Controllers\S300Controller;
use App\Controllers\ChannelController;
use App\Controllers\InspectionController;
use App\Controllers\VehicleController;
use App\Controllers\SettingsController;
use App\Controllers\OperationLogController;
use App\Controllers\AuthController;
use App\Controllers\EventStreamController;
use App\Controllers\VipController;
use App\Controllers\BlacklistController;
use App\Controllers\CronController;
use App\Controllers\VisitsController;
use App\Controllers\MqttQueueController;
use App\Controllers\MqttLogController;
use App\Controllers\DashboardController;
use App\Controllers\RoadBlockerController;
use App\Controllers\AdminController;

// ===== CORS =====
$origin = $_SERVER['HTTP_ORIGIN'] ?? '*';
header('Access-Control-Allow-Origin: ' . $origin);
header('Vary: Origin');
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
header('Access-Control-Max-Age: 86400');

// ===== Error handling =====
if ($GLOBALS['APP_CONFIG']['app']['debug']) {
    error_reporting(E_ALL);
    ini_set('display_errors', '1');
}
set_exception_handler(function (\Throwable $e) {
    \App\Core\Logger::error('Uncaught: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Response::serverError($e->getMessage());
});

// ===== Routes =====
$router = new Router();

$router->get('/',           fn() => ['code' => 200, 'message' => 'ANPR + S300 Backend', 'data' => ['version' => '1.0.0', 'time' => date('c')]]);
$router->get('/api/health', fn() => ['code' => 200, 'message' => 'ok', 'data' => ['time' => date('c')]]);

// === Inbound (S300 -> Platform). MUST match S300 documented paths. ===
$inbound = new InboundController();
$router->post('/overseas/s300/work-status',    fn($r) => $inbound->workStatus($r));
$router->post('/overseas/s300/face-image',     fn($r) => $inbound->faceImage($r));
$router->post('/overseas/s300/video-record',   fn($r) => $inbound->videoRecord($r));
$router->post('/overseas/s300/video-real-time', fn($r) => $inbound->videoRealTime($r));
$router->post('/overseas/s300/reset-complete', fn($r) => $inbound->resetComplete($r));
$router->post('/overseas/s300/uvis',           fn($r) => $inbound->uvis($r));
$router->post('/overseas/s300/x-ray',          fn($r) => $inbound->xray($r));

// === Outbound (Platform -> S300) ===
$s300 = new S300Controller();
$router->post('/api/s300/come/{channelNo}',              fn($r) => $s300->come($r));
$router->get ('/api/s300/capture/{channelNo}',           fn($r) => $s300->capture($r));
$router->get ('/api/s300/leave/{channelNo}',             fn($r) => $s300->leave($r));
$router->post('/api/s300/read-work-status/{channelNo}',  fn($r) => $s300->readWorkStatus($r));
$router->post('/api/s300/emergency-stop/{channelNo}',    fn($r) => $s300->emergencyStop($r));
$router->post('/api/s300/manual-reset/{channelNo}',      fn($r) => $s300->manualReset($r));
$router->post('/api/s300/audio-prompt',                  fn($r) => $s300->audioPrompt($r));
$router->post('/api/s300/video-playback',                fn($r) => $s300->videoPlayback($r));

// === Channels CRUD ===
$ch = new ChannelController();
$router->get   ('/api/channels',                 fn($r) => $ch->index($r));
$router->post  ('/api/channels',                 fn($r) => $ch->create($r));
$router->get   ('/api/channels/{id}',            fn($r) => $ch->show($r));
$router->put   ('/api/channels/{id}',            fn($r) => $ch->update($r));
$router->delete('/api/channels/{id}',            fn($r) => $ch->destroy($r));
$router->get   ('/api/channels/by-no/{channelNo}/status', fn($r) => $ch->status($r));

// === Location master (channel zone picklist) ===
$loc = new \App\Controllers\LocationController();
$router->get   ('/api/locations',      fn($r) => $loc->index($r));
$router->post  ('/api/locations',      fn($r) => $loc->create($r));
$router->delete('/api/locations/{id}', fn($r) => $loc->destroy($r));

// === VIP plates CRUD ===
$vip = new VipController();
$router->get   ('/api/vip',              fn($r) => $vip->index($r));
$router->post  ('/api/vip',              fn($r) => $vip->create($r));
$router->put   ('/api/vip/{id}',         fn($r) => $vip->update($r));
$router->delete('/api/vip/{id}',         fn($r) => $vip->destroy($r));
$router->get   ('/api/vip/check/{plate}', fn($r) => $vip->check($r));

// === Blacklist plates CRUD (ANPR-stage deny list) ===
$bl = new BlacklistController();
$router->get   ('/api/blacklist',               fn($r) => $bl->index($r));
$router->post  ('/api/blacklist',               fn($r) => $bl->create($r));
$router->put   ('/api/blacklist/{id}',          fn($r) => $bl->update($r));
$router->delete('/api/blacklist/{id}',          fn($r) => $bl->destroy($r));
$router->get   ('/api/blacklist/check/{plate}', fn($r) => $bl->check($r));

// === X-ray review + vendor receipt ===
$xrayCtl = new \App\Controllers\XrayController();
$router->get ('/api/xray',              fn($r) => $xrayCtl->index($r));
$router->post('/api/xray/room-come/{channelNo}', fn($r) => $xrayCtl->roomCome($r));
$router->post('/api/xray/{id}/review',  fn($r) => $xrayCtl->review($r));
$router->post('/api/xray/{id}/resend',  fn($r) => $xrayCtl->resend($r));

// === Global logging queue (worker drains -> partner gateCarEntry) ===
$glog = new \App\Controllers\GlobalLogController();
$router->get ('/api/global-log/pending',      fn($r) => $glog->pending($r));
$router->post('/api/global-log/{id}/sent',     fn($r) => $glog->markSent($r));
$router->post('/api/global-log/{id}/failed',   fn($r) => $glog->markFailed($r));

// === Cron / timeout sweep ===
$cron = new CronController();
$router->post('/api/cron/tick', fn($r) => $cron->tick($r));

// === Visits (entry/exit reporting) ===
$visits = new VisitsController();
$router->get ('/api/visits',             fn($r) => $visits->index($r));
$router->get ('/api/visits/summary',     fn($r) => $visits->summary($r));
$router->post('/api/visits/record-exit', fn($r) => $visits->recordExit($r));
$router->post('/api/visits/{id}/orphan-allow', fn($r) => $visits->orphanAllow($r));
$router->post('/api/visits/{id}/orphan-deny',  fn($r) => $visits->orphanDeny($r));
$router->get ('/api/visits/{id}/orphan-candidates', fn($r) => $visits->orphanCandidates($r));
$router->post('/api/visits/{id}/orphan-pair',  fn($r) => $visits->orphanPair($r));

// === MQTT outbound queue (worker drains this) ===
$mq = new MqttQueueController();
$router->get ('/api/mqtt-queue/pending',     fn($r) => $mq->pending($r));
$router->post('/api/mqtt-queue/clear',       fn($r) => $mq->clear($r));
$router->post('/api/mqtt-queue/{id}/sent',   fn($r) => $mq->sent($r));
$router->post('/api/mqtt-queue/{id}/failed', fn($r) => $mq->failed($r));

// === MQTT logs (per-device monitoring) ===
$mlog = new MqttLogController();
$apilog = new \App\Controllers\ApiLogController();
$router->get ('/api/api-log',                fn($r) => $apilog->index($r));
$router->post('/api/mqtt-log/inbound',       fn($r) => $mlog->ingest($r));
$router->get ('/api/mqtt-log/devices',       fn($r) => $mlog->devices($r));
$router->get ('/api/mqtt-log/inbound',       fn($r) => $mlog->inbound($r));
$router->get ('/api/mqtt-log/outbound',      fn($r) => $mlog->outbound($r));
$router->get ('/api/mqtt-log/message-names', fn($r) => $mlog->messageNames($r));

// === Dashboard snapshot ===
$dash = new DashboardController();
$router->get('/api/dashboard', fn($r) => $dash->index($r));

// === Manual ANPR camera actions (ANPR Control page) — per channel ===
$anpr = new \App\Controllers\AnprController();
$router->post('/api/anpr/speak',     fn($r) => $anpr->speak($r));
$router->post('/api/anpr/gate-open', fn($r) => $anpr->gateOpen($r));

// === Road blocker (CORX relay) — manual control panel ===
$rb = new RoadBlockerController();
$router->get ('/api/road-blocker/status',    fn($r) => $rb->status($r));
$router->post('/api/road-blocker/open',      fn($r) => $rb->open($r));
$router->post('/api/road-blocker/close',     fn($r) => $rb->close($r));
$router->post('/api/road-blocker/stop',      fn($r) => $rb->stop($r));
$router->post('/api/road-blocker/auto-open', fn($r) => $rb->setAutoOpen($r));
// Multi-lane: bulk (all lanes) + per-lane control + future sensor hook.
$router->post('/api/road-blocker/ack',                      fn($r) => $rb->ack($r));
$router->post('/api/road-blocker/heartbeat',                fn($r) => $rb->heartbeat($r));
$router->post('/api/road-blocker/bulk/{action}',            fn($r) => $rb->bulk($r));
$router->post('/api/road-blocker/lane/{channelNo}/sensor',    fn($r) => $rb->sensor($r));
$router->post('/api/road-blocker/lane/{channelNo}/auto-open', fn($r) => $rb->setLaneAutoOpen($r));
$router->post('/api/road-blocker/lane/{channelNo}/{action}', fn($r) => $rb->laneAction($r));

// === Inspections ===
$ins = new InspectionController();
$router->get('/api/inspections',       fn($r) => $ins->index($r));
$router->get('/api/inspections/{id}',  fn($r) => $ins->show($r));
$router->post('/api/inspections/{id}/approve', fn($r) => $ins->approve($r));
$router->post('/api/inspections/{id}/reject',  fn($r) => $ins->reject($r));
$router->post('/api/inspections/{id}/route-xray', fn($r) => $ins->routeXray($r));

// === Vehicles ===
$v = new VehicleController();
$router->get ('/api/vehicles', fn($r) => $v->index($r));
$router->post('/api/vehicles', fn($r) => $v->create($r));

// === Settings ===
$s = new SettingsController();
$router->get('/api/settings', fn($r) => $s->index($r));
$router->put('/api/settings', fn($r) => $s->update($r));

// === Operation log (audit) ===
$ol = new OperationLogController();
$router->get('/api/operation-log',        fn($r) => $ol->index($r));
$router->get('/api/operation-log/facets', fn($r) => $ol->facets($r));

// === Auth (SSO-only — login is brokered by the parent platform via ?username=) ===
$auth = new AuthController();
$router->post('/api/auth/sso', fn($r) => $auth->sso($r));
$router->post('/api/auth/login', fn($r) => $auth->login($r));
$router->get ('/api/auth/me',  fn($r) => $auth->me($r));

// === Admin / testing utilities (gated to debug/dev_bypass) ===
$admin = new AdminController();
$router->post('/api/admin/reset-data', fn($r) => $admin->resetData($r));

// === Event stream (SSE) ===
$es = new EventStreamController();
$router->get('/api/events/stream', fn($r) => $es->stream($r));

$router->dispatch(new Request());
