/**
 * 功能管理模块
 *
 * 监听 store 配置变化，自动开启/关闭对应的插件功能。
 * 在 index.tsx 的 load() 中调用 initFeatures() 即可。
 */

import { logger } from '@/index'
import { store } from '@/lib/store'
import { lcu, LcuEventUri, queueIdToTag } from '@/lib/lcu'
import type { LCUEventMessage, GameflowPhase, ChampSelectSession } from '@/lib/lcu'
import { sleep } from '@/lib/utils'
import { updateChampSelectQuitButton } from '@/lib/features/champselect-quit-button'
import { updateAutoAccept } from '@/lib/features/auto-accept'
import { updateAllowDeclineAfterAccept } from '@/lib/features/ready-check-control'
import { updateHideEsportsPopup } from '@/lib/features/hide-esports-popup'
import { updateDebugGameflow } from '@/lib/features/debug-gameflow'
import { updateBenchNoCooldown } from '@/lib/features/bench-no-cooldown'
import { updateGlobalParticle } from '@/lib/features/global-particle'
import { updateFriendSmartGroup } from '@/lib/features/friend-smart-group'
import { updateAutoLockChampion } from '@/lib/features/auto-lock-champion'
import { updateAutoBanChampion } from '@/lib/features/auto-ban-champion'
import { applyRankDisguise, updateRankDisguise } from '@/lib/features/rank-disguise'
import { updateCustomProfileBg } from '@/lib/features/profile-background'
import { updateCustomBanner } from '@/lib/features/custom-banner'
import { updateGameAnalysisPopup } from '@/lib/features/game-analysis-popup'
import { updateAutoReturnToLobby } from '@/lib/features/auto-return-to-lobby'
import { updateBeautifyCustomAvatar } from '@/lib/features/beautify-client/custom-avatar'
import { initSocialSidebarGlass, updateSocialSidebarGlassConfig } from '@/lib/features/beautify-client/social-sidebar-glass'
import { initBeautifyNavbarBlur, updateBeautifyNavbarBlur } from '@/lib/features/beautify-client/navbar-blur'
import { initBeautifyNavbarLines, updateBeautifyNavbarLines } from '@/lib/features/beautify-client/navbar-lines'
import { initSummonerNameEffect, updateSummonerNameEffect } from '@/lib/features/beautify-client/summoner-name-effect'
import { updateBeautifyHomepageBackground, updateBeautifyHomepageBackgroundAdjustments, updateBeautifyHomepageBackgroundGlassConfig } from '@/lib/features/beautify-client/homepage-background'
import { updateBeautifyWallpaperMode, updateBeautifyWallpaperModeGlassConfig, updateBeautifyWallpaperSceneConfig } from '@/lib/features/beautify-client/wallpaper-mode'
import { updateGameModeFilter } from '@/lib/features/game-mode-filter'
import { updateQuickLobbyMode } from '@/lib/features/quick-lobby-mode'
import { setHideTFTEnabled, setHideRightNavTextEnabled } from '@/lib/injections'
import {
  calculateSonaPlayerStrengthScore,
  filterSonaStrengthGamesByQueue,
  shouldSkipSonaStrengthGame,
  type SonaPlayerStrengthScore,
} from '@/lib/player-strength-score'
import { deobfuscateChampSelectPuuid } from '@/lib/champ-select-puuid'
import { translate } from '@/i18n'

// ==================== 共享：查询队友胜率 ====================

type ChampSelectTeamPlayer = ChampSelectSession['myTeam'][number]

function getAnalyzableTeamPlayers(session: ChampSelectSession): ChampSelectTeamPlayer[] {
  return session.myTeam.filter((player) => Boolean(player.puuid) || Boolean(player.obfuscatedPuuid))
}

interface TeammateStats {
  floor: number
  summonerId: number
  puuid: string
  obfuscatedSummonerId: number
  obfuscatedPuuid: string
  gameName: string
  tagLine: string
  winRate: number | null  // null = 查询失败或无战绩
  wins: number
  total: number
  avgK: number
  avgD: number
  avgA: number
  kdaNum: number
  strengthScore: SonaPlayerStrengthScore | null
}

interface TeamStatsResult {
  isBlue: boolean
  stats: TeammateStats[]
  queueId: number
  fetchCount: number
}

function getPlayerStatsKey(player: Pick<ChampSelectTeamPlayer, 'puuid' | 'summonerId' | 'obfuscatedPuuid' | 'obfuscatedSummonerId' | 'cellId'>): string {
  if (player.puuid) return `puuid:${player.puuid}`
  if (player.summonerId) return `summoner:${player.summonerId}`
  if (player.obfuscatedPuuid) return `obfuscated-puuid:${player.obfuscatedPuuid}`
  if (player.obfuscatedSummonerId) return `obfuscated-summoner:${player.obfuscatedSummonerId}`
  return `cell:${player.cellId}`
}

function getTeammateStatsKey(stat: TeammateStats): string {
  // 匿名模式下优先使用会话中的混淆 ID，换楼后仍可与最新 session 稳定对应。
  if (stat.obfuscatedPuuid) return `obfuscated-puuid:${stat.obfuscatedPuuid}`
  if (stat.obfuscatedSummonerId) return `obfuscated-summoner:${stat.obfuscatedSummonerId}`
  if (stat.puuid) return `puuid:${stat.puuid}`
  if (stat.summonerId) return `summoner:${stat.summonerId}`
  return `floor:${stat.floor}`
}

/**
 * 正常模式直接使用 puuid；匿名模式则还原 obfuscatedPuuid。
 * 只处理 HIDDEN，避免未来客户端引入其他可见性类型时误判。
 */
function resolveChampSelectPuuid(player: ChampSelectTeamPlayer): string {
  if (player.puuid) return player.puuid
  if (player.nameVisibilityType !== 'HIDDEN' || !player.obfuscatedPuuid) return ''
  return deobfuscateChampSelectPuuid(player.obfuscatedPuuid)
}

/** 去重：同一个 ChampSelect 阶段多个功能需要同一份数据时，复用同一轮请求 */
let _fetchTeamStatsPromise: Promise<TeamStatsResult> | null = null

/**
 * 查询当前选人阶段所有队友的近期战绩
 * 使用 SGP 接口 + tag 参数按当前游戏模式服务端过滤，拉 100 条
 * 返回 { isBlue, queueId, stats[], fetchCount }
 *
 * 多次并发调用会复用同一轮请求（promise 去重）
 */
async function fetchTeamStats(): Promise<TeamStatsResult> {
  if (_fetchTeamStatsPromise) return _fetchTeamStatsPromise

  _fetchTeamStatsPromise = _doFetchTeamStats()
  try {
    return await _fetchTeamStatsPromise
  } finally {
    _fetchTeamStatsPromise = null
  }
}

async function _doFetchTeamStats(): Promise<TeamStatsResult> {
  const session = await lcu.getChampSelectSession()
  const localPlayer = session.myTeam.find((p) => p.cellId === session.localPlayerCellId)
  const isBlue = localPlayer ? localPlayer.cellId < 5 : true

  // 直接从 ChampSelectSession 拿 queueId，无需额外请求
  const currentQueueId = session.queueId
  logger.info('[TeamStats] 当前队列 ID: %d', currentQueueId)

  // 将 queueId 转为 SGP tag
  const tag = queueIdToTag(currentQueueId)

  const FETCH_COUNT = store.get('analyzeTeamPowerFetchCount') || 50

  /** 构造占位元素：查询失败时仍保留身份信息，供弹窗标题与换楼匹配使用 */
  const placeholder = (
    player: ChampSelectTeamPlayer,
    i: number,
    resolvedPuuid = resolveChampSelectPuuid(player),
    resolvedIdentity?: { summonerId?: number; gameName?: string; tagLine?: string },
  ): TeammateStats => ({
    floor: i + 1,
    summonerId: resolvedIdentity?.summonerId || player.summonerId,
    puuid: resolvedPuuid,
    obfuscatedSummonerId: player.obfuscatedSummonerId,
    obfuscatedPuuid: player.obfuscatedPuuid,
    gameName: resolvedIdentity?.gameName || player.gameName,
    tagLine: resolvedIdentity?.tagLine || player.tagLine,
    winRate: null,
    wins: 0,
    total: 0,
    avgK: 0,
    avgD: 0,
    avgA: 0,
    kdaNum: 0,
    strengthScore: null,
  })

  // 跳过查不到数据的占位玩家（斗魂模式 myTeam 含空位），其余保留占位以对齐楼层索引
  const analyzablePlayers = getAnalyzableTeamPlayers(session)
  const hiddenPlayers = analyzablePlayers.filter((player) => player.nameVisibilityType === 'HIDDEN' && !player.puuid)
  if (hiddenPlayers.length > 0) {
    const resolvedCount = hiddenPlayers.filter((player) => Boolean(resolveChampSelectPuuid(player))).length
    logger.info('[TeamStats] 匿名模式身份还原: %d/%d', resolvedCount, hiddenPlayers.length)
  }

  const stats = await Promise.all(analyzablePlayers.map(async (player, i) => {
    const puuid = resolveChampSelectPuuid(player)
    if (!puuid) {
      logger.warn('[TeamStats] %d楼缺少可查询的 PUUID（visibility=%s）', i + 1, player.nameVisibilityType || 'unknown')
      return placeholder(player, i, '')
    }

    const needsIdentityBackfill = !player.gameName || !player.tagLine || !player.summonerId
    // 匿名模式的 ChampSelectSession 会清空 Riot ID；用已还原的真实 PUUID 从 Summoner 接口回填。
    const identityPromise = needsIdentityBackfill
      ? lcu.getSummonerByPuuid(puuid).catch((error) => {
          logger.warn('[TeamStats] %d楼 Riot ID 回填失败:', i + 1, error)
          return null
        })
      : Promise.resolve(null)

    try {
      // 与 SGP 并行请求，避免给队友战力分析增加串行等待时间。
      const [resp, summoner] = await Promise.all([
        lcu.getSgpMatchHistory(puuid, {
          startIndex: 0,
          count: FETCH_COUNT,
          tag: tag || undefined,
        }),
        identityPromise,
      ])
      const gameName = player.gameName || summoner?.gameName || summoner?.displayName || ''
      const tagLine = player.tagLine || summoner?.tagLine || ''
      const summonerId = player.summonerId || summoner?.summonerId || 0
      const resolvedIdentity = { summonerId, gameName, tagLine }

      if (needsIdentityBackfill && gameName) {
        logger.info('[TeamStats] %d楼匿名 Riot ID 回填成功 → %s%s', i + 1, gameName, tagLine ? `#${tagLine}` : '')
      }

      const receivedGames = resp.games ?? []
      const games = filterSonaStrengthGamesByQueue(receivedGames, currentQueueId)

      const matchStats: Array<{ kills: number; deaths: number; assists: number; win: boolean }> = []

      for (const game of games) {
        const p = game.json.participants.find((pt) => pt.puuid === puuid)
        if (!p) continue
        if (shouldSkipSonaStrengthGame(game, puuid)) continue

        matchStats.push({
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          win: p.win,
        })
      }

      if (matchStats.length === 0) {
        return placeholder(player, i, puuid, resolvedIdentity)
      }

      let wins = 0, totalKills = 0, totalDeaths = 0, totalAssists = 0
      for (const g of matchStats) {
        if (g.win) wins++
        totalKills += g.kills
        totalDeaths += g.deaths
        totalAssists += g.assists
      }

      const total = matchStats.length
      const strengthScore = calculateSonaPlayerStrengthScore(games, puuid)
      logger.info(
        '[TeamStats] %s → 当前模式有效 %d 场 / 返回 %d 场 (queueId=%d, tag=%s)',
        gameName,
        total,
        receivedGames.length,
        currentQueueId,
        tag || '全部',
      )

      return {
        floor: i + 1,
        summonerId,
        puuid,
        obfuscatedSummonerId: player.obfuscatedSummonerId,
        obfuscatedPuuid: player.obfuscatedPuuid,
        gameName,
        tagLine,
        winRate: (wins / total) * 100,
        wins,
        total,
        avgK: totalKills / total,
        avgD: totalDeaths / total,
        avgA: totalAssists / total,
        kdaNum: totalDeaths === 0 ? totalKills + totalAssists : (totalKills + totalAssists) / totalDeaths,
        strengthScore,
      } as TeammateStats
    } catch (error) {
      logger.warn('[TeamStats] %d楼战绩查询失败（visibility=%s）:', i + 1, player.nameVisibilityType || 'unknown', error)
      // 即使 SGP 失败，也等待已发出的 Summoner 请求，以免弹窗标题和日志再次丢失名字。
      const summoner = await identityPromise
      return placeholder(player, i, puuid, {
        summonerId: player.summonerId || summoner?.summonerId || 0,
        gameName: player.gameName || summoner?.gameName || summoner?.displayName || '',
        tagLine: player.tagLine || summoner?.tagLine || '',
      })
    }
  }))

  return { isBlue, queueId: currentQueueId, stats, fetchCount: FETCH_COUNT }
}

// ==================== 选人阶段辅助信息 ====================

/**
 * 根据胜率和 KDA 给出 LOL 风格幽默评价
 */
export function getRating(winRate: number, kda: number): string {
  if (winRate >= 75 && kda >= 4.5) return translate('champSelect.rating.godlike')
  if (winRate >= 70) return translate('champSelect.rating.smurf')
  if (winRate >= 65) return translate('champSelect.rating.hardCarry')
  if (winRate >= 60) return translate('champSelect.rating.specialist')
  if (winRate >= 56) return translate('champSelect.rating.steady')
  if (winRate >= 52) return translate('champSelect.rating.helper')
  if (winRate >= 48) return translate('champSelect.rating.swing')
  if (winRate >= 45) return translate('champSelect.rating.holding')
  if (winRate >= 41) return translate('champSelect.rating.autofill')
  if (winRate >= 37) return translate('champSelect.rating.losing')
  if (winRate >= 33) return translate('champSelect.rating.breakpoint')
  if (winRate >= 28) return translate('champSelect.rating.atm')
  if (winRate >= 20) return translate('champSelect.rating.surrender')
  return translate('champSelect.rating.actor')
}

const TEAM_POWER_TITLE_KEYS = [
  'strength.teamTier.ace',
  'strength.teamTier.high',
  'strength.teamTier.mid',
  'strength.teamTier.low',
  'strength.teamTier.burden',
] as const

function assignTeamPowerTitles(stats: TeammateStats[]): Map<string, string> {
  const ranked = [...stats]
    .filter((stat): stat is TeammateStats & { strengthScore: SonaPlayerStrengthScore } => Boolean(stat.strengthScore))
    .sort((a, b) => b.strengthScore.score - a.strengthScore.score)

  const titles = new Map<string, string>()
  ranked.forEach((stat, index) => {
    titles.set(getTeammateStatsKey(stat), translate(TEAM_POWER_TITLE_KEYS[Math.min(index, TEAM_POWER_TITLE_KEYS.length - 1)]))
  })

  return titles
}

async function analyzeTeammates() {
  try {
    const { stats, fetchCount } = await fetchTeamStats()

    logger.info('┌─── 队友战绩分析 ───')

    const chatLines: string[] = [translate('champSelect.teamAnalysis.header', { count: fetchCount })]
    const teamPowerTitles = assignTeamPowerTitles(stats)

    for (const s of stats) {
      const floor = translate('champSelect.teamAnalysis.floor', { floor: s.floor })
      if (s.winRate == null) {
        logger.info('│ %s — %s#%s — 无近期战绩或查询失败', floor, s.gameName, s.tagLine)
        chatLines.push(translate('champSelect.teamAnalysis.emptyLine', { floor }))
        continue
      }

      const winRate = s.winRate.toFixed(1)
      const kdaStr = s.kdaNum >= 99 ? 'Perfect' : s.kdaNum.toFixed(2)
      const title = teamPowerTitles.get(getTeammateStatsKey(s)) ?? translate('strength.teamTier.newbie')
      const scoreText = s.strengthScore ? s.strengthScore.score.toFixed(1) : '--'

      logger.info(
        '│ %s — %s#%s — 近%d场 胜率: %s%% (%d胜%d负) | KDA: %s (%.1f/%.1f/%.1f) | 综合评分: %s | %s',
        floor, s.gameName, s.tagLine,
        s.total, winRate, s.wins, s.total - s.wins,
        kdaStr, s.avgK, s.avgD, s.avgA, scoreText, title,
      )

      chatLines.push(translate('champSelect.teamAnalysis.line', { floor, title, winRate, kda: kdaStr, score: scoreText }))
    }

    logger.info('└────────────────────')

    // 等待聊天室就绪后发送
    const msg = chatLines.join('\n')
    const msgType = store.get('analyzeTeamPowerMsgType') || 'celebration'
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await lcu.sendChampSelectMessage(msg, msgType)
        logger.info('队友分析已发送到聊天框 ✓')
        break
      } catch {
        if (attempt < 9) {
          await sleep(1000)
        } else {
          logger.warn('聊天发送失败，聊天室始终未就绪')
        }
      }
    }
  } catch (err) {
    logger.error('队友战绩分析失败:', err)
  }
}

let analyzeTeamPowerUnsub: (() => void) | null = null

function updateAnalyzeTeamPower(enabled: boolean) {
  if (enabled && !analyzeTeamPowerUnsub) {
    analyzeTeamPowerUnsub = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
      const phase = event.data as GameflowPhase
      if (phase === 'ChampSelect') {
        analyzeTeammates()
      }
    })
    logger.info('Analyze team power enabled ✓')
  } else if (!enabled && analyzeTeamPowerUnsub) {
    analyzeTeamPowerUnsub()
    analyzeTeamPowerUnsub = null
    logger.info('Analyze team power disabled')
  }
}

// ==================== 选人阶段红蓝方提示 ====================

async function sendSideIndicator() {
  try {
    const session = await lcu.getChampSelectSession()
    const localPlayer = session.myTeam.find((p) => p.cellId === session.localPlayerCellId)
    const isBlue = localPlayer ? localPlayer.cellId < 5 : true
    const sideText = isBlue ? translate('champSelect.side.blue') : translate('champSelect.side.red')

    // 注意：选人阶段暂时拿不到本局大乱斗随机地图。
    // 实测 /lol-gameflow/v1/session 的 map.gameMutator / mapMutator 在 ChampSelect 阶段为空字符串，
    // 客户端应当是进入游戏后才知道本局随机到嚎哭深渊、屠夫之桥或莲华栈桥，因此这里不展示地图名。
    const msg = translate('champSelect.side.message', { side: sideText })
    const msgType = store.get('sideIndicatorMsgType') || 'celebration'
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await lcu.sendChampSelectMessage(msg, msgType)
        logger.info('红蓝方提示已发送 → %s', sideText)
        break
      } catch {
        if (attempt < 9) {
          await sleep(1000)
        } else {
          logger.warn('红蓝方提示发送失败，聊天室始终未就绪')
        }
      }
    }
  } catch (err) {
    logger.error('红蓝方提示失败:', err)
  }
}

let sideIndicatorUnsub: (() => void) | null = null

function updateSideIndicator(enabled: boolean) {
  if (enabled && !sideIndicatorUnsub) {
    sideIndicatorUnsub = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
      const phase = event.data as GameflowPhase
      if (phase === 'ChampSelect') {
        sendSideIndicator()
      }
    })
    logger.info('Side indicator enabled ✓')
  } else if (!enabled && sideIndicatorUnsub) {
    sideIndicatorUnsub()
    sideIndicatorUnsub = null
    logger.info('Side indicator disabled')
  }
}

// ==================== 初始化 ====================


/**
 * 初始化所有功能
 * 根据 store 当前值启用功能，并监听后续变化
 */
function syncSocialSidebarGlassConfig() {
  const config = {
    blur: store.get('beautifyGlassBlur'),
    opacity: store.get('beautifyGlassOpacity'),
  }

  updateSocialSidebarGlassConfig(config)
  updateBeautifyWallpaperModeGlassConfig(config)
}

function syncWallpaperSceneConfig() {
  updateBeautifyWallpaperSceneConfig({
    blur: store.get('beautifyWallpaperSceneBlur'),
    opacity: store.get('beautifyWallpaperSceneOpacity'),
  })
}

function syncHomepageBackgroundGlassConfig() {
  updateBeautifyHomepageBackgroundGlassConfig({
    blur: store.get('beautifyHomepageBackgroundBlur'),
    opacity: store.get('beautifyHomepageBackgroundOpacity'),
  })
}

/**
 * 自定义主页背景只在壁纸模式开启时挂载。
 * 关闭模式时传入 null 会注销注入任务，并移除 viewport 下的视频和背景样式；
 * 已选择的资源路径仍保留在 store 中，重新开启后可以直接恢复。
 */
function syncHomepageBackground() {
  updateBeautifyHomepageBackground(
    store.get('beautifyWallpaperMode')
      ? store.get('beautifyHomepageBackgroundAssetPath')
      : null,
  )
}

function syncWallpaperMode() {
  updateBeautifyWallpaperMode(store.get('beautifyWallpaperMode'))
  syncHomepageBackground()
}

function pickRandomHomepageBackgroundOnStartup() {
  if (!store.get('beautifyHomepageBackgroundRandom')) return

  const assetPaths = store.get('beautifyHomepageBackgroundAssetPaths').filter(Boolean)
  if (assetPaths.length === 0) return

  const lastAssetPath = store.get('beautifyHomepageBackgroundLastRandomAssetPath')
  const candidates = assetPaths.length > 1
    ? assetPaths.filter((assetPath) => assetPath !== lastAssetPath)
    : assetPaths
  const selectedAssetPath = candidates[Math.floor(Math.random() * candidates.length)]
  if (!selectedAssetPath) return

  store.set('beautifyHomepageBackgroundAssetPath', selectedAssetPath)
  store.set('beautifyHomepageBackgroundLastRandomAssetPath', selectedAssetPath)
  logger.info('[HomepageBackground] 随机启动壁纸：%s', selectedAssetPath)
}

export function initFeatures() {
  updateAutoAccept(store.get('autoAcceptMatch'))
  store.onChange('autoAcceptMatch', updateAutoAccept)

  updateAllowDeclineAfterAccept(store.get('allowDeclineAfterAccept'))
  store.onChange('allowDeclineAfterAccept', updateAllowDeclineAfterAccept)

  updateDebugGameflow(store.get('developerMode'))
  store.onChange('developerMode', updateDebugGameflow)

  updateBenchNoCooldown(store.get('benchNoCooldown'))
  store.onChange('benchNoCooldown', updateBenchNoCooldown)

  updateAnalyzeTeamPower(store.get('analyzeTeamPower'))
  store.onChange('analyzeTeamPower', updateAnalyzeTeamPower)

  updateSideIndicator(store.get('sideIndicator'))
  store.onChange('sideIndicator', updateSideIndicator)

  updateGlobalParticle(store.get('globalParticle'))
  store.onChange('globalParticle', updateGlobalParticle)

  updateFriendSmartGroup(store.get('friendSmartGroup'))
  store.onChange('friendSmartGroup', updateFriendSmartGroup)

  updateCustomProfileBg(store.get('customProfileBg'))
  store.onChange('customProfileBg', updateCustomProfileBg)

  updateCustomBanner(store.get('customBanner'))
  store.onChange('customBanner', updateCustomBanner)

  updateBeautifyCustomAvatar()
  store.onChange('customAvatarAssetPaths', updateBeautifyCustomAvatar)

  initSocialSidebarGlass()
  syncSocialSidebarGlassConfig()
  store.onChange('beautifyGlassBlur', syncSocialSidebarGlassConfig)
  store.onChange('beautifyGlassOpacity', syncSocialSidebarGlassConfig)

  initBeautifyNavbarBlur()
  updateBeautifyNavbarBlur(store.get('beautifyNavbarBlur'))
  store.onChange('beautifyNavbarBlur', updateBeautifyNavbarBlur)

  initBeautifyNavbarLines()
  updateBeautifyNavbarLines(store.get('beautifyNavbarHideLines'))
  store.onChange('beautifyNavbarHideLines', updateBeautifyNavbarLines)

  initSummonerNameEffect()
  updateSummonerNameEffect(store.get('beautifySummonerNameEffect'))
  store.onChange('beautifySummonerNameEffect', updateSummonerNameEffect)

  syncHomepageBackgroundGlassConfig()
  store.onChange('beautifyHomepageBackgroundBlur', syncHomepageBackgroundGlassConfig)
  store.onChange('beautifyHomepageBackgroundOpacity', syncHomepageBackgroundGlassConfig)
  updateBeautifyHomepageBackgroundAdjustments(store.get('beautifyHomepageBackgroundAdjustments'))
  store.onChange('beautifyHomepageBackgroundAdjustments', updateBeautifyHomepageBackgroundAdjustments)
  pickRandomHomepageBackgroundOnStartup()
  store.onChange('beautifyHomepageBackgroundAssetPath', syncHomepageBackground)

  syncWallpaperMode()
  store.onChange('beautifyWallpaperMode', syncWallpaperMode)

  syncWallpaperSceneConfig()
  store.onChange('beautifyWallpaperSceneBlur', syncWallpaperSceneConfig)
  store.onChange('beautifyWallpaperSceneOpacity', syncWallpaperSceneConfig)

  // 段位伪装：启动时自动应用，配置变化时重新应用
  updateRankDisguise(store.get('rankDisguise'))
  store.onChange('rankDisguise', updateRankDisguise)
  // 队列/段位/子段位变化时，如果开关开着就重新应用
  store.onChange('rankQueue', () => { if (store.get('rankDisguise')) applyRankDisguise() })
  store.onChange('rankTier', () => { if (store.get('rankDisguise')) applyRankDisguise() })
  store.onChange('rankDivision', () => { if (store.get('rankDisguise')) applyRankDisguise() })

  updateAutoLockChampion(store.get('autoLockChampion'))
  store.onChange('autoLockChampion', updateAutoLockChampion)

  updateAutoBanChampion(store.get('autoBanChampion'))
  store.onChange('autoBanChampion', updateAutoBanChampion)
  store.onChange('autoBanChampionIds', () => updateAutoBanChampion(store.get('autoBanChampion')))

  updateChampSelectQuitButton(store.get('champSelectQuitButton'))
  store.onChange('champSelectQuitButton', updateChampSelectQuitButton)

  updateGameAnalysisPopup(store.get('gameAnalysisPopup'))
  store.onChange('gameAnalysisPopup', updateGameAnalysisPopup)

  updateAutoReturnToLobby(store.get('autoReturnToLobby'))
  store.onChange('autoReturnToLobby', updateAutoReturnToLobby)
  store.onChange('autoReturnMode', () => {
    // 模式变化时，如果功能已启用，重新注册以应用新模式
    if (store.get('autoReturnToLobby')) {
      updateAutoReturnToLobby(false)
      updateAutoReturnToLobby(true)
    }
  })

  // 隐藏云顶之弈入口
  setHideTFTEnabled(store.get('hideTFT'))
  store.onChange('hideTFT', setHideTFTEnabled)

  // 隐藏主页右侧导航栏文字
  setHideRightNavTextEnabled(store.get('hideRightNavText'))
  store.onChange('hideRightNavText', setHideRightNavTextEnabled)

  // 关闭右下角赛事直播弹窗
  updateHideEsportsPopup(store.get('hideEsportsPopup'))
  store.onChange('hideEsportsPopup', updateHideEsportsPopup)

  // 玩家对战模式可见性勾选条
  updateGameModeFilter(store.get('gameModeFilter'))
  store.onChange('gameModeFilter', updateGameModeFilter)

  // 快速大厅模式（点击 Play 直接进目标队列）
  updateQuickLobbyMode(store.get('quickLobbyMode'))
  store.onChange('quickLobbyMode', updateQuickLobbyMode)

  // 恢复窗口特效
  const savedEffect = store.get('windowEffect')
  if (savedEffect && savedEffect !== 'none') {
    Effect.apply(savedEffect as 'acrylic', { color: '#0006' })
    logger.info('Restored window effect: %s', savedEffect)
  }

  logger.info('Features initialized ✓')
}
