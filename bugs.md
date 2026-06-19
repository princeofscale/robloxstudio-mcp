# Bugs & Issues — MCP

Баги MCP, найденные при догфудинге. Severity: 🔴 high · 🟡 medium · 🟢 low/cosmetic.

## ✅ Все исправлены (2026-06-19)
| # | Что | Фикс |
|---|-----|------|
| B1 | placeholder-имена в поиске | `marketplace-client`: `enrich()` через `items/details` → реальные name/creator/votes/price + `buildThumbnailUrl()` на каждый результат; `rankByRelevanceAndPopularity()` |
| B2 | insert блокируется auth | `assets.ts:interpretInsertResponse` + `insert_asset`/`marketplace_search_and_insert` перебирают ранжированных кандидатов, пропускают AUTH-locked, отдают типизированную ошибку+hint |
| B3/B5 | path-resolver «not found» | резолвер общий (`getInstanceByPath`) → расхождения не было; `get_instance_children` ретраит 1 раз на `NOT_FOUND` (debounce-лаг); insert даёт чёткую NOT_FOUND-подсказку |
| B4 | ложный timeout на тяжёлом luau | `bridge-service`: таймаут из `MCP_REQUEST_TIMEOUT_MS`, `resolveRequestTimeout()` даёт execute-luau ≥120с, текст ошибки «код мог выполниться» |
| B6 | ошибки без кодов | `errors.ts`: `classifyError`/`typedError`/`responseErrorCode` → `TIMEOUT/AUTH/NOT_FOUND/PLUGIN_DISCONNECTED/RATE_LIMITED` |
| B7 | пресеты без пост-эффектов | `environment_set_lighting_preset(withPostFx)` → Future + идемпотентные Bloom/ColorCorrection/SunRays |
| B8 | пустые буферы логов в плейтесте | `RuntimeLogBuffer.install()` сидит из `LogService:GetLogHistory()` — стартовые принты сервера не теряются |

Ниже — исходные описания (для контекста).

---

## 🔴 B1 — `marketplace_search` returns generic placeholder names

**What happened:** При поиске ассетов (`marketplace_search` для «low poly tree») результаты приходят
с именами вида `Asset <id>` вместо реальных названий моделей и без превью/метаданных
(creator, тип ассета, бесплатный/платный).

**Impact:** Невозможно понять, что именно вставляешь, до фактической вставки. Приходится
угадывать по ID.

**Likely cause:** В `marketplace-client.ts` не вытягиваются `name` / `creatorName` /
`thumbnailUrl` из ответа Roblox catalog/toolbox API — отдаётся только сырой assetId.

**Fix idea:** Дёргать `https://catalog.roblox.com/v1/catalog/items/details` (или toolbox
`https://apis.roblox.com/toolbox-service/v1/marketplace/...`) и маппить `name`, `creatorName`,
`assetType`, `price`, `thumbnailUrl` в результат поиска.

---

## 🔴 B2 — `insert_asset` blocked by Roblox auth for toolbox models

**What happened:** Все 5 ID моделей «low poly tree» из toolbox дали
`User is not authorized to access Asset`.

**Impact:** Вставка большинства toolbox-моделей в edit-режиме просто не работает.

**Cause (НЕ баг нашего кода):** `InsertService:LoadAsset` в Edit грузит только ассеты,
которыми владеет пользователь, либо публично-бесплатные (free, copy-unlocked). Toolbox
часто отдаёт copy-locked модели.

**Fix idea:**
- Перед вставкой проверять доступность ассета (`get_asset_details` → `IsPublicDomain` /
  `canCopy`), и в `marketplace_search` фильтровать/помечать недоступные.
- Возвращать пользователю понятную ошибку с подсказкой («ассет copy-locked, выбери free»),
  а не сырое исключение Roblox.
- Документировать ограничение в README (раздел marketplace).

---

## 🟡 B3 — Path-resolution inconsistency: `insert_asset` vs `marketplace_search_and_insert`

**What happened:** `insert_asset` с `parent = "game.Workspace.Map"` →
`Parent instance not found`, при том что `marketplace_search_and_insert` тем же путём
ассет резолвит нормально.

**Impact:** Один и тот же путь работает в одном tool и падает в другом — непредсказуемо.

**Likely cause:** Два разных кодовых пути резолвинга (PATH_RESOLVER_LUA vs ручной
`FindFirstChild`-обход), которые расходятся в обработке `game.` префикса / сервисов.

**Fix idea:** Свести оба к единому `PATH_RESOLVER_LUA` из `luau-emit.ts`.

---

## 🟡 B4 — `execute_luau` intermittent "Studio plugin connection timeout"

**What happened:** Несколько длинных `execute_luau` (процедурный декор, ~25 деревьев)
вернули `Studio plugin connection timeout`, хотя `get_connected_instances` показывал
плагин всё ещё подключённым, а часть эффекта могла примениться.

**Impact:** Неясно, выполнился код или нет → риск частичного/двойного применения
(особенно для не-идемпотентных скриптов с `:Destroy()`).

**Likely cause:** Жёсткий таймаут HTTP long-poll в `http-server.ts` короче времени
выполнения тяжёлого Luau на стороне плагина; ответ теряется, хотя работа идёт.

**Fix idea:**
- Поднять/сделать конфигурируемым таймаут для `execute_luau`.
- Возвращать `requestId` и поллить статус (async-выполнение) вместо одного блокирующего
  запроса.
- В сообщении об ошибке явно писать «код мог выполниться — проверь состояние», т.к.
  таймаут ≠ провал.

---

## 🟡 B5 — `get_instance_children "game.Workspace.Map"` → "Instance not found"

**What happened:** После создания `Workspace.Map` через MapBuilder
`get_instance_children` по пути `game.Workspace.Map` иногда отдавал `Instance not found`,
хотя объект, судя по всему, существовал.

**Impact:** Чтение дерева ненадёжно → тестер не может проверить результат своих же правок.

**Likely cause:** Связано с B3 (резолвинг пути) и/или B4 (плагин занят/таймаут отдал
устаревшее состояние). Нужен воспроизводимый кейс.

**Fix idea:** Унифицировать резолвинг (см. B3); добавить retry на стороне tool при
`Instance not found`, если плагин подтверждён подключённым.

---

## 🟢 B6 — Таймаут не отличается от провала в сообщениях об ошибках

**What happened:** Сквозная проблема: connection timeout, auth error и «реально не
выполнилось» выглядят для вызывающего одинаково (просто текст ошибки).

**Fix idea:** Ввести типизированные коды ошибок (`TIMEOUT`, `AUTH`, `NOT_FOUND`,
`PLUGIN_DISCONNECTED`) в ответах tools, чтобы агент мог корректно ретраить/проверять.

---

## 🟢 B7 — `environment_set_lighting_preset` / `set_atmosphere` work, but no idempotent post-FX

**Observation (loop iter 1, positive dogfood):** `environment_set_lighting_preset("simulator")`
и `environment_set_atmosphere(...)` отработали чисто, без ошибок. НО: пресеты не добавляют
полировочные пост-эффекты (Bloom/ColorCorrection/SunRays/DepthOfField) и не выставляют
`Lighting.Technology = Future` — пришлось дописывать через execute_luau вручную.

**Fix idea:** Расширить `simulator`/`realistic`/`sunny` пресеты, чтобы они создавали
именованные пост-эффекты (idempotent — `FindFirstChild` по имени) и опционально включали
Future lighting. Можно вынести в опцию `withPostFx: true`.

## 🟡 B8 — Playtest: буферы логов server/client пустые, `get_playtest_output` рассинхрон

**Observation (loop iter 9):** При `start_playtest(play)` (roles: edit/server/client-1)
`get_runtime_logs target=all` вернул только edit-prints; буферы `server` и `client-1`
пусты (`perCaptureNextSince server:0, client-1:0`) — стартовый принт игрового сервера
(«[Brainrot Farm Defense] Сервер запущен.») не пойман. Также `get_playtest_output
target=server` вернул `isRunning:false`, тогда как default-вызов — `isRunning:true`.

**Impact:** Тестер не видит серверных/клиентских логов в обычном (не StudioTestService)
плейтесте → сложно ловить рантайм-ошибки игровой логики.

**Likely cause:** (а) сервер печатает на старте ДО того, как MCP-буфер подключился к
peer'у; (б) рассинхрон `isRunning` между `get_playtest_output` target=server vs default.
В обычном play LogService шарится (см. `peerAttribution: unavailable_shared_logservice`),
так что server/client буферы могут не наполняться отдельно.

**Fix idea:** Подключать буфер peer'а раньше (до запуска game-скриптов) или
ретроактивно подтягивать LogService.GetLogHistory() при старте; выровнять семантику
`isRunning` между таргетами. Документировать, что для надёжных пер-peer логов нужен
`multiplayer_test_start` (StudioTestService).

## Notes
- **Аудио ≠ модели (loop iter 12):** аудио-ассеты из библиотеки Roblox (например
  `rbxassetid://1837879082`) ЗАГРУЖАЮТСЯ в Edit (`IsLoaded=true`, `TimeLength` валиден) и
  играют — в отличие от copy-locked toolbox-моделей (B2). Значит звук можно добавлять
  через MCP надёжно; ограничение B2 специфично для InsertService:LoadAsset моделей.
- B1, B2 — самые приоритетные: ломают весь marketplace-флоу (вставку ассетов).
- B3/B5 — вероятно один корень (резолвинг путей); чинить вместе.
- B4/B6 — надёжность транспорта execute_luau.
