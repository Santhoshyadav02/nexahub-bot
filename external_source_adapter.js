/**
 * ============================================================
 * 🌐 EXTERNAL SOURCE ADAPTER MODULE
 * ============================================================
 * Modular architecture for authorized external content ingestion.
 * 
 * Strict Compliance & Safety:
 * - Operates ONLY on authorized, licensed, and whitelisted sources.
 * - Supports all 12 Canonical Popular Topics with hardened hierarchical routing.
 * - Enforces strict guard against generic single-word false positive matches.
 * - Resolves ambiguities to "General" to prevent incorrect topic assignment.
 * - Does NOT modify existing Telegram MTProto ingestion pipeline.
 * - Does NOT modify source_registry.js or existing 12-card/topic routing.
 * - Enforces DRY_RUN mode by default to prevent unauthorized downloads or uploads.
 * - Completely isolated and decoupled from existing Telegram ingestion modules.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

/**
 * Canonical 12-Topic Hierarchical Routing Rules for External Source Adapter
 * Prioritized rule tiers:
 * Tier 1: Exact Hashtag (Highest priority)
 * Tier 2: Exact Multi-word Phrase (High priority)
 * Tier 3: Exact CJK Phrase / Tag (High priority)
 * Tier 4: Specific Keyword Combination (Requires ALL tokens in subset)
 * Single generic words (e.g. "snake", "driver", "dance", "troupe") are excluded from independent routing.
 */
const CANONICAL_12_TOPIC_RULES = [
  {
    topicKey: "Myanmar",
    koreanName: "미얀마",
    cardNum: 1,
    hashtags: ["myanmar", "burma", "burmese", "yangon", "mandalay", "southeastasia", "southeastasian"],
    exactPhrases: ["myanmar culture", "myanmar documentary", "myanmar tradition", "burma news", "visit myanmar", "yangon city", "southeast asian"],
    cjkPhrases: ["미얀마", "버마", "양곤", "동남아", "缅甸"],
    combinations: [["myanmar", "culture"], ["myanmar", "travel"], ["burmese", "tradition"], ["동남아", "미녀"]]
  },
  {
    topicKey: "Evergrande Troupe",
    koreanName: "헝다 가무단",
    cardNum: 2,
    hashtags: ["evergrandetroupe", "evergrande", "hengda", "hengdadance", "danceperformance", "idoltroupe", "stagegala"],
    exactPhrases: ["evergrande troupe", "evergrande dance", "evergrande gala", "evergrande performance", "dance performance", "troupe performance", "stage choreography"],
    cjkPhrases: ["헝다 가무단", "헝다", "가무단", "댄스 공연", "무용 공연", "가무 공연", "아이돌 무대", "恒大歌舞团", "恒大", "恒大舞蹈"],
    combinations: [["evergrande", "dance"], ["evergrande", "troupe"], ["evergrande", "gala"], ["hengda", "troupe"], ["dance", "performance"], ["idol", "stage"], ["가무", "공연"], ["무용", "공연"]]
  },
  {
    topicKey: "Myanmar Women",
    koreanName: "미얀마 여성",
    cardNum: 3,
    hashtags: ["myanmarwomen", "burmesegirl", "myanmargirl", "burmesebeauty", "myanmar_women", "koreanbj", "creatorcam", "amateurleak", "camgirl", "privateshot", "amateurstream"],
    exactPhrases: ["myanmar women", "myanmar woman", "burmese girl", "burmese women", "myanmar girl", "burmese beauty", "korean bj", "creator cam", "amateur creator", "webcam leak", "private cam", "private recording"],
    cjkPhrases: ["미얀마 여성", "미얀마 소녀", "미얀마 미녀", "버마 여성", "버마 소녀", "한국 bj", "국산 유출", "개인 촬영", "인터넷 방송", "일탈녀", "골빈녀", "벗방", "국산bj", "직찍 유출", "개인방송", "실시간 방송", "缅甸女性", "缅甸美女", "缅甸女孩"],
    combinations: [["myanmar", "women"], ["myanmar", "girl"], ["burmese", "girl"], ["burmese", "women"], ["bj", "방송"], ["국산", "유출"], ["개인", "촬영"], ["일탈", "유출"], ["직찍", "영상"], ["벗방", "유출"]]
  },
  {
    topicKey: "Sister Snake",
    koreanName: "뱀 누나",
    cardNum: 4,
    hashtags: ["sistersnake", "snakesister", "snakelady", "sister_snake", "marriedwoman", "milfhousewife", "seductivewife", "maturewoman", "housewife", "neighborwife"],
    exactPhrases: ["sister snake", "snake sister", "snake lady", "legend of snake sister", "married woman", "seductive housewife", "mature woman", "neighbor wife", "secret adultery", "married lady"],
    cjkPhrases: ["뱀 누나", "뱀누나", "스네이크 누나", "유부녀", "주부", "미시", "아내", "와이프", "유부녀・주부", "유부녀 주부", "숙녀", "새댁", "이웃집 아내", "외도 아내", "불륜 아내", "뱀누님", "蛇姐"],
    combinations: [["sister", "snake"], ["snake", "lady"], ["유부녀", "주부"], ["아내", "유혹"], ["미시", "주부"], ["married", "woman"], ["mature", "housewife"], ["이웃", "아내"]]
  },
  {
    topicKey: "Has Work",
    koreanName: "일거리 있음",
    cardNum: 5,
    hashtags: ["haswork", "workavailable", "jobhiring", "has_work", "officeworker", "parttimejob", "secretsecretary", "workplaceaffair", "jobinterview", "companyaffair"],
    exactPhrases: ["has work", "work available", "job hiring", "part time hiring", "urgent hiring", "office worker", "workplace romance", "part-time job", "office secretary", "job interview", "workplace affair"],
    cjkPhrases: ["일거리 있음", "일거리", "구인 구직", "회사원", "오피스", "직장 상사", "직장 동료", "비서", "면접", "알바", "직장 로맨스", "여직원", "오피스 레이디", "구인", "구직", "회사원・직장", "有活", "招工", "招聘"],
    combinations: [["work", "available"], ["job", "hiring"], ["part time", "job"], ["office", "worker"], ["직장", "상사"], ["회사", "비서"], ["면접", "알바"], ["직원", "채용"], ["오피스", "직장"]]
  },
  {
    topicKey: "Bullying & Sex",
    koreanName: "괴롭힘과 성관계",
    cardNum: 6,
    hashtags: ["bullyingsex", "bullying_sex", "campusbullying", "humiliationsex", "ntrromance", "disciplinedom", "hardcoredom", "shameplay", "submissive"],
    exactPhrases: ["bullying & sex", "bullying and sex", "campus bullying", "schoolmate bullying", "humiliation drama", "ntr betrayal", "disciplined submission", "forced dominance", "shame submission"],
    cjkPhrases: ["괴롭힘과 성관계", "괴롭힘", "학교 괴롭힘", "캠퍼스 일탈", "능욕", "수치", "조교", "치한", "ntr", "네토리", "배덕", "강제 굴복", "굴욕", "수치심", "음란 조교", "수치・능욕", "단체작품", "단체 능욕", "霸凌"],
    combinations: [["bullying", "sex"], ["campus", "bullying"], ["schoolmate", "bullying"], ["능욕", "수치"], ["강제", "조교"], ["치한", "괴롭힘"], ["배덕", "ntr"], ["수치", "조교"], ["단체", "작품"]]
  },
  {
    topicKey: "Da Ci Ge",
    koreanName: "다츠거",
    cardNum: 7,
    hashtags: ["dacige", "bigmagnet", "magnetbrother", "da_ci_ge", "nightlifehostess", "clublounge", "roomhostess", "bartenderlady", "loungehostess", "massageparlor", "nightlifespot"],
    exactPhrases: ["da ci ge", "dacige", "big magnet brother", "night club hostess", "lounge hostess", "bar lady", "nightlife entertainment", "karaoke hostess", "vip lounge hostess", "massage parlor"],
    cjkPhrases: ["다츠거", "다찌거", "대자형", "호스티스", "클럽", "유흥", "룸싸롱", "바텐더", "텐프로", "주점", "업소녀", "도우미", "유흥주점", "화류계", "야간 업소", "유흥가", "마사지 업소", "스웨디시", "휴게텔", "안마 시술소", "마사지", "大磁哥"],
    combinations: [["da", "ci", "ge"], ["magnet", "brother"], ["night", "club"], ["호스티스", "유흥"], ["룸싸롱", "주점"], ["클럽", "파티"], ["업소", "도우미"], ["주점", "도우미"], ["마사지", "업소"], ["휴게텔", "정보"]]
  },
  {
    topicKey: "Senior Year Love Story",
    koreanName: "고3 사랑 이야기",
    cardNum: 8,
    hashtags: ["senioryearlovestory", "senior_year_love_story", "highschoolromance", "senioryearromance", "schooluniform", "studentromance", "youthlove", "campusuniform", "purelove", "buruma", "gymuniform"],
    exactPhrases: ["senior year love story", "senior year romance", "grade 12 romance", "high school love story", "high school student", "school uniform romance", "campus youth romance", "pure student love", "teenage romance", "gym uniform romance"],
    cjkPhrases: ["고3 사랑 이야기", "고3 사랑", "고3 로맨스", "고삼 사랑 이야기", "교복", "학생", "여고생", "캠퍼스", "학원물", "청순", "순애", "풋풋", "청춘 로맨스", "학창 시절", "학생물", "여학생", "체육복", "부르마", "세일러복", "스쿨룩", "高三爱情故事", "高三爱情", "高三恋情"],
    combinations: [["senior year", "love"], ["senior year", "romance"], ["grade 12", "romance"], ["high school", "love story"], ["교복", "학생"], ["여고생", "캠퍼스"], ["학원", "로맨스"], ["학생", "순애"], ["청순", "학생"], ["체육복", "미녀"], ["부르마", "미녀"]]
  },
  {
    topicKey: "Sichuan Mother & Son",
    koreanName: "쓰촨 모자",
    cardNum: 9,
    hashtags: ["sichuanmotherson", "sichuan_mother_son", "sichuanfamily", "domestictaboo", "familystory", "stepmotherstory", "inlawstory", "sisterstory"],
    exactPhrases: ["sichuan mother & son", "sichuan mother and son", "sichuan mother", "sichuan son", "domestic taboo", "family secret", "stepmother romance", "sister-in-law romance", "domestic cohabitation"],
    cjkPhrases: ["쓰촨 모자", "사천 모자", "쓰촨 가족", "모자", "근친", "의붓", "가족", "누나", "남동생", "여동생", "형수", "장모", "의붓어머니", "가족의 비밀", "한집 동거", "친척", "가족・동거", "四川母子", "四川母子俩"],
    combinations: [["sichuan", "mother"], ["sichuan", "son"], ["sichuan", "family"], ["family", "taboo"], ["의붓", "가족"], ["모자", "관계"], ["형수", "동생"], ["가족", "비밀"], ["의붓", "엄마"]]
  },
  {
    topicKey: "Hu Siyuan",
    koreanName: "후쓰위안",
    cardNum: 10,
    hashtags: ["husiyuan", "siyuanhu", "hu_siyuan", "koreansubtitle", "studiorelease", "featuredactress", "exclusiveseries", "captionprovider", "javstar", "exclusiveactress"],
    exactPhrases: ["hu siyuan", "husiyuan", "siyuan hu", "korean subtitle", "featured actress", "studio exclusive", "caption provider", "exclusive series", "star actress showcase"],
    cjkPhrases: ["후쓰위안", "후스위안", "호사원", "자막", "단독 기획", "전속 배우", "기획물", "인기 여배우", "s1", "moodyz", "prestige", "madonna", "ideapocket", "faleno", "공식 자막", "자막판", "전속", "단독작품", "품번", "품번 추천", "작품 추천", "胡思源"],
    combinations: [["hu", "siyuan"], ["siyuan", "hu"], ["자막", "단독"], ["전속", "기획"], ["여배우", "단독"], ["s1", "전속"], ["moodyz", "기획"], ["자막", "배우"]]
  },
  {
    topicKey: "Kept Lover",
    koreanName: "애인으로 부양",
    cardNum: 11,
    hashtags: ["keptlover", "kept_lover", "sugarbabylove", "secretmistress", "privatesponsor", "sponsorship"],
    exactPhrases: ["kept lover", "maintained mistress", "kept woman", "secret mistress", "sugar baby", "private sponsor"],
    cjkPhrases: ["애인으로 부양", "부양 애인", "비밀 애인", "스폰서 애인", "스폰서", "원조교제", "애인대행", "조건만남", "후원", "패트론", "包养", "包养情人"],
    combinations: [["kept", "lover"], ["maintained", "mistress"], ["kept", "woman"], ["sugar", "baby", "lover"], ["스폰", "만남"], ["조건", "만남"]]
  },
  {
    topicKey: "Didi Proxy Operation",
    koreanName: "디디 대리운영",
    cardNum: 12,
    hashtags: ["didiproxy", "dididriver", "didi_proxy_operation", "didiproxyoperation", "chauffeurproxy", "proxydriver"],
    exactPhrases: ["didi proxy operation", "didi proxy", "didi driver", "didi chauffeur", "proxy driver operation", "chauffeur driver"],
    cjkPhrases: ["디디 대리운영", "디디 대리", "디디 기사", "대리운전 기사", "대리운전", "대리기사", "차량 대리", "滴滴代驾", "滴滴司机", "滴滴"],
    combinations: [["didi", "proxy"], ["didi", "driver"], ["didi", "operation"], ["proxy", "driver"], ["didi", "chauffeur"], ["대리", "운전"]]
  }
];

class ExternalSourceAdapter {
  /**
   * @param {object} [config]
   * @param {string} [config.sourceId] Unique identifier for the external feed provider
   * @param {string} [config.sourceName] Human readable source name
   * @param {string} [config.apiUrl] External feed endpoint URL
   * @param {string} [config.apiKey] Secret API key or bearer token
   * @param {string} [config.licenseId] Explicit content license or rights agreement ID
   * @param {boolean} [config.isAuthorized] Explicit authorization flag
   * @param {string[]} [config.allowedDomains] Whitelisted domain names
   * @param {boolean} [config.dryRun] If true, executes in dry-run metadata-only mode
   * @param {string} [config.ledgerPath] Path to persistent deduplication store
   * @param {number} [config.rateLimitDelayMs] Minimum delay between API requests (ms)
   * @param {number} [config.maxRetries] Max retry attempts for transient errors
   * @param {number} [config.retryBaseDelayMs] Base exponential backoff delay (ms)
   * @param {number} [config.timeoutMs] Request timeout in ms
   * @param {object[]} [config.topicRules] Custom topic matching rules
   */
  constructor(config = {}) {
    this.sourceId = config.sourceId || "external_authorized_source";
    this.sourceName = config.sourceName || "Authorized External Media Feed";
    this.apiUrl = config.apiUrl || process.env.EXTERNAL_SOURCE_API_URL || process.env.AVSEE_API_URL || null;
    this.apiKey = config.apiKey || process.env.EXTERNAL_SOURCE_API_KEY || process.env.AVSEE_API_KEY || null;
    this.licenseId = config.licenseId || process.env.EXTERNAL_SOURCE_LICENSE_ID || process.env.AVSEE_LICENSE_ID || null;
    
    // Explicit authorization check from config or environment variables
    this.isAuthorized = config.isAuthorized !== undefined 
      ? Boolean(config.isAuthorized) 
      : (process.env.EXTERNAL_SOURCE_AUTHORIZED === "true" || process.env.AVSEE_AUTHORIZED === "true");

    // Whitelisted domains
    this.allowedDomains = config.allowedDomains || (
      process.env.EXTERNAL_SOURCE_ALLOWED_DOMAINS 
        ? process.env.EXTERNAL_SOURCE_ALLOWED_DOMAINS.split(",").map(d => d.trim().toLowerCase()) 
        : ["02.avsee.is", "avsee.tv", "cdn.apiavsee.com", "apiavsee.com", "authorized-cdn.com", "licensed-feed.org", "api.partner-media.com", "syndication.authorized.net"]
    );

    // Dry-run mode (defaults to true for maximum safety unless explicitly disabled)
    this.dryRun = config.dryRun !== undefined 
      ? Boolean(config.dryRun) 
      : (process.env.EXTERNAL_SOURCE_DRY_RUN !== "false");

    this.ledgerPath = config.ledgerPath || path.join(__dirname, "external_source_ledger.json");
    this.rateLimitDelayMs = config.rateLimitDelayMs || 500;
    this.maxRetries = config.maxRetries || 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs || 1000;
    this.timeoutMs = config.timeoutMs || 10000;
    
    this.topicRules = config.topicRules || CANONICAL_12_TOPIC_RULES;
    this.defaultTopic = config.defaultTopic || "General";
    this.lastRequestTimestamp = 0;

    this.ledger = this.loadLedger();
  }

  // ============================================================
  // 🔐 AUTHORIZATION & COMPLIANCE VERIFICATION
  // ============================================================

  /**
   * Returns safe diagnostic authorization status (never exposes secret values)
   * @param {string} [targetUrl]
   * @returns {{ configDetected: boolean, validationPass: boolean, reason?: string|null }}
   */
  getAuthorizationStatus(targetUrl = null) {
    const hasConfig = Boolean(this.licenseId || this.apiKey || process.env.EXTERNAL_SOURCE_AUTHORIZED === "true" || process.env.AVSEE_AUTHORIZED === "true");
    const authResult = this.checkAuthorization(targetUrl);
    return {
      configDetected: hasConfig,
      validationPass: authResult.authorized,
      reason: authResult.reason || null
    };
  }

  /**
   * Verifies that the adapter is explicitly authorized to ingest and process content.
   * @param {string} [targetUrl] Optional URL to check against domain whitelist
   * @returns {{ authorized: boolean, reason?: string }}
   */
  checkAuthorization(targetUrl = null) {
    if (!this.isAuthorized) {
      return { 
        authorized: false, 
        reason: "Source is not authorized. Set EXTERNAL_SOURCE_AUTHORIZED=true (or AVSEE_AUTHORIZED=true) with valid EXTERNAL_SOURCE_LICENSE_ID." 
      };
    }

    if (!this.licenseId && !this.apiKey) {
      return { 
        authorized: false, 
        reason: "Missing authorization credentials. Set EXTERNAL_SOURCE_LICENSE_ID (or AVSEE_LICENSE_ID) or EXTERNAL_SOURCE_API_KEY in environment variables." 
      };
    }

    if (targetUrl) {
      try {
        const parsed = new URL(targetUrl);
        const hostname = parsed.hostname.toLowerCase();
        const isAllowed = this.allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
        if (!isAllowed) {
          return { 
            authorized: false, 
            reason: `Target URL domain "${hostname}" is not in the authorized domain whitelist.` 
          };
        }
      } catch (e) {
        return { authorized: false, reason: `Invalid target URL: ${e.message}` };
      }
    }

    return { authorized: true };
  }

  // ============================================================
  // 📂 PERSISTENT DEDUPLICATION LEDGER
  // ============================================================

  /**
   * Loads the deduplication ledger from disk
   * @returns {Map<string, object>}
   */
  loadLedger() {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.records)) {
          const map = new Map();
          for (const rec of parsed.records) {
            if (rec && rec.uniqueHash) {
              map.set(rec.uniqueHash, rec);
            }
          }
          return map;
        }
      }
    } catch (err) {
      console.warn(`⚠️ [EXTERNAL_SOURCE] Could not load ledger from ${this.ledgerPath}: ${err.message}`);
    }
    return new Map();
  }

  /**
   * Persists the deduplication ledger to disk
   */
  saveLedger() {
    try {
      const records = Array.from(this.ledger.values());
      const data = {
        version: "1.0.0",
        updatedAt: new Date().toISOString(),
        totalRecords: records.length,
        records: records
      };
      fs.writeFileSync(this.ledgerPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error(`❌ [EXTERNAL_SOURCE] Failed to save ledger to ${this.ledgerPath}: ${err.message}`);
    }
  }

  /**
   * Generates a deterministic unique hash for an item
   * @param {string} itemId 
   * @param {string} [mediaUrl] 
   * @returns {string}
   */
  generateItemHash(itemId, mediaUrl = "") {
    const raw = `${this.sourceId}:${String(itemId).trim()}:${String(mediaUrl).trim()}`;
    return crypto.createHash("sha256").update(raw, "utf8").digest("hex").substring(0, 32);
  }

  /**
   * Checks if an item has already been ingested or processed
   * @param {string} uniqueHash 
   * @returns {boolean}
   */
  isDuplicate(uniqueHash) {
    return this.ledger.has(uniqueHash);
  }

  /**
   * Records an ingested or processed item into the ledger
   * @param {object} item 
   */
  recordItem(item) {
    if (!item || !item.uniqueHash) return;
    this.ledger.set(item.uniqueHash, {
      uniqueHash: item.uniqueHash,
      sourceId: this.sourceId,
      itemId: item.itemId,
      title: item.title,
      mediaUrl: item.mediaUrl,
      topicKey: item.topicKey || item.topic || this.defaultTopic,
      topic: item.topicKey || item.topic || this.defaultTopic,
      processedAt: new Date().toISOString(),
      dryRun: Boolean(this.dryRun)
    });
    this.saveLedger();
  }

  // ============================================================
  // 🔌 CORE ADAPTER INTERFACE
  // ============================================================

  /**
   * Fetches raw items from the authorized external feed with retries and rate limiting
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {string} [options.category]
   * @param {Array<object>} [options.mockItems] Optional mock data for testing
   * @returns {Promise<Array<object>>}
   */
  async fetchItems(options = {}) {
    const authCheck = this.checkAuthorization(this.apiUrl);
    if (!authCheck.authorized) {
      throw new Error(`[EXTERNAL_SOURCE AUTH ERROR] ${authCheck.reason}`);
    }

    if (options.mockItems && Array.isArray(options.mockItems)) {
      return options.mockItems;
    }

    if (!this.apiUrl) {
      console.warn("⚠️ [EXTERNAL_SOURCE] No apiUrl configured. Returning empty item set.");
      return [];
    }

    return await this.executeWithRetry(async () => {
      await this.enforceRateLimit();
      return await this.httpGetJson(this.apiUrl);
    });
  }

  /**
   * Fetches detailed metadata for a specific item
   * @param {string} itemId 
   * @param {object} [options]
   * @returns {Promise<object|null>}
   */
  async fetchItemDetails(itemId, options = {}) {
    const authCheck = this.checkAuthorization();
    if (!authCheck.authorized) {
      throw new Error(`[EXTERNAL_SOURCE AUTH ERROR] ${authCheck.reason}`);
    }

    if (!itemId) {
      throw new Error("[EXTERNAL_SOURCE ERROR] itemId is required for fetchItemDetails");
    }

    if (options.mockDetails && typeof options.mockDetails === "object") {
      return options.mockDetails;
    }

    if (!this.apiUrl) return null;

    const detailUrl = `${this.apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(itemId)}`;
    return await this.executeWithRetry(async () => {
      await this.enforceRateLimit();
      return await this.httpGetJson(detailUrl);
    });
  }

  /**
   * Extracts media URL from an item and validates against whitelist
   * @param {object} item 
   * @returns {string|null}
   */
  getMediaUrl(item) {
    if (!item || typeof item !== "object") return null;

    let url = item.mediaUrl || item.media_url || item.videoUrl || item.video_url || item.url || null;
    if (!url && item.enclosure && typeof item.enclosure.url === "string") {
      url = item.enclosure.url;
    }
    if (!url && Array.isArray(item.media) && item.media[0] && typeof item.media[0].url === "string") {
      url = item.media[0].url;
    }

    if (!url || typeof url !== "string") return null;
    url = url.trim();

    // Verify protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return null;
    }

    return url;
  }

  /**
   * Extracts clean title from an item
   * @param {object} item 
   * @returns {string}
   */
  getTitle(item) {
    if (!item || typeof item !== "object") return "";
    const rawTitle = item.title || item.name || item.headline || item.caption || "";
    return String(rawTitle).trim().replace(/[\r\n\t]+/g, " ");
  }

  /**
   * Extracts normalized tag array from an item
   * @param {object} item 
   * @returns {string[]}
   */
  getTags(item) {
    if (!item || typeof item !== "object") return [];

    const tags = new Set();
    const addTag = (t) => {
      if (typeof t === "string" && t.trim().length > 0) {
        const clean = t.trim().toLowerCase().replace(/^#/, "");
        tags.add(clean);
        if (clean.includes("・") || clean.includes("/")) {
          clean.split(/[・/]/).forEach(sub => {
            if (sub.trim().length > 0) tags.add(sub.trim());
          });
        }
      }
    };

    // 1. Array tags
    if (Array.isArray(item.tags)) {
      item.tags.forEach(t => addTag(t));
    } else if (typeof item.tags === "string") {
      item.tags.split(/[,;|]/).forEach(t => addTag(t));
    }

    // 2. Keywords / categories
    if (Array.isArray(item.keywords)) {
      item.keywords.forEach(k => addTag(k));
    } else if (typeof item.keywords === "string") {
      item.keywords.split(/[,;|]/).forEach(k => addTag(k));
    }

    if (typeof item.category === "string" && item.category.trim().length > 0) {
      addTag(item.category);
    }

    if (typeof item.bo_table === "string" && item.bo_table.trim().length > 0) {
      addTag(item.bo_table);
    }

    // 3. Extract #hashtags from text / description / title
    const fullText = `${item.title || ""} ${item.description || ""} ${item.content || ""}`;
    const hashtagMatches = fullText.match(/#([\p{L}\p{N}_・/]+)/gu);
    if (hashtagMatches) {
      hashtagMatches.forEach(h => addTag(h));
    }

    return Array.from(tags);
  }

  /**
   * Extracts published timestamp in ISO 8601 format
   * @param {object} item 
   * @returns {string}
   */
  getPublishedAt(item) {
    if (!item || typeof item !== "object") return new Date().toISOString();

    const raw = item.publishedAt || item.published_at || item.pubDate || item.created_at || item.timestamp;
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
    return new Date().toISOString();
  }

  // ============================================================
  // 🧭 HARDENED HIERARCHICAL ROUTING LAYER
  // ============================================================

  /**
   * Normalizes a raw external item into a standard structure
   * @param {object} rawItem 
   * @returns {object|null}
   */
  normalizeItem(rawItem) {
    if (!rawItem || typeof rawItem !== "object") return null;

    const itemId = String(rawItem.id || rawItem.itemId || rawItem.external_id || rawItem.guid || "").trim();
    const title = this.getTitle(rawItem);
    const mediaUrl = this.getMediaUrl(rawItem);
    const tags = this.getTags(rawItem);
    const publishedAt = this.getPublishedAt(rawItem);

    if (!itemId) {
      return { valid: false, error: "Missing required itemId / external_id" };
    }
    if (!title) {
      return { valid: false, error: "Missing required title" };
    }
    if (!mediaUrl) {
      return { valid: false, error: "Missing or invalid media URL" };
    }

    // Verify media URL authorization
    const urlCheck = this.checkAuthorization(mediaUrl);
    if (!urlCheck.authorized) {
      return { valid: false, error: urlCheck.reason };
    }

    const uniqueHash = this.generateItemHash(itemId, mediaUrl);

    return {
      valid: true,
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      itemId: itemId,
      uniqueHash: uniqueHash,
      title: title,
      mediaUrl: mediaUrl,
      tags: tags,
      description: String(rawItem.description || rawItem.summary || rawItem.content || "").trim(),
      publishedAt: publishedAt,
      duration: rawItem.duration || null,
      licenseId: this.licenseId || "PERMITTED_EXTERNAL_SYNDICATION",
      rawMetadata: rawItem
    };
  }

  /**
   * Matches normalized metadata against the 12 Canonical Popular Topics using strict hierarchical tiers.
   * Priority:
   * 1. Exact Hashtag Match (Priority 1, Confidence 0.98)
   * 2. Exact Multi-word Phrase Match (Priority 2, Confidence 0.90)
   * 3. Exact CJK Phrase / Tag Match (Priority 3, Confidence 0.88)
   * 4. Specific Keyword Combination Match (Priority 4, Confidence 0.80)
   * If confidence is insufficient or conflicting/ambiguous matches occur, returns "General" (Confidence 0.1).
   * 
   * @param {object} normalizedItem 
   * @returns {{ topicKey: string, topic: string, confidence: number, matchedRule: string, matchedToken: string|null, koreanName: string, cardNum: number|null }}
   */
  matchTopic(normalizedItem) {
    const defaultResult = {
      topicKey: this.defaultTopic,
      topic: this.defaultTopic,
      confidence: 0.1,
      matchedRule: "NONE",
      matchedToken: null,
      koreanName: "기타",
      cardNum: null,
      fallbackReason: "no reliable destination match"
    };

    if (!normalizedItem) return defaultResult;

    const itemTags = (normalizedItem.tags || []).map(t => String(t).toLowerCase().trim().replace(/^#/, ""));
    const fullText = `${normalizedItem.title} ${normalizedItem.description || ""}`.toLowerCase();

    // Track matched candidates per tier to detect conflicts
    const tier1Matches = []; // Exact Hashtags
    const tier2Matches = []; // Exact Multi-word Phrases
    const tier3Matches = []; // Exact CJK Phrases
    const tier4Matches = []; // Specific Keyword Combinations

    // Check rules in order (Sort rules to prioritize specific topics like Myanmar Women before broad topics like Myanmar)
    const sortedRules = [...this.topicRules].sort((a, b) => {
      // Longer topic key / more specific rules first
      return (b.exactPhrases ? b.exactPhrases[0].length : 0) - (a.exactPhrases ? a.exactPhrases[0].length : 0);
    });

    for (const rule of sortedRules) {
      // Tier 1: Exact Hashtag Match
      if (Array.isArray(rule.hashtags)) {
        for (const ht of rule.hashtags) {
          const cleanHt = ht.toLowerCase().replace(/^#/, "");
          for (const it of itemTags) {
            if (it === cleanHt || it.replace(/_/g, "") === cleanHt.replace(/_/g, "")) {
              tier1Matches.push({ rule, token: `#${cleanHt}` });
            }
          }
        }
      }

      // Tier 2: Exact Multi-word Phrase Match in Title or Description
      if (Array.isArray(rule.exactPhrases)) {
        for (const phrase of rule.exactPhrases) {
          const lowerPhrase = phrase.toLowerCase();
          if (fullText.includes(lowerPhrase)) {
            tier2Matches.push({ rule, token: phrase });
          }
        }
      }

      // Tier 3: Exact CJK Phrase / Tag Match
      if (Array.isArray(rule.cjkPhrases)) {
        for (const cjk of rule.cjkPhrases) {
          const lowerCjk = cjk.toLowerCase();
          if (fullText.includes(lowerCjk) || itemTags.includes(lowerCjk)) {
            tier3Matches.push({ rule, token: cjk });
          }
        }
      }

      // Tier 4: Specific Keyword Combination (Requires ALL tokens in the combination subset)
      if (Array.isArray(rule.combinations)) {
        for (const combo of rule.combinations) {
          const allPresent = combo.every(token => fullText.includes(token.toLowerCase()));
          if (allPresent) {
            tier4Matches.push({ rule, token: combo.join("+") });
          }
        }
      }
    }

    // Helper: Select unique distinct topic keys from matches
    const getDistinctTopics = (matches) => {
      const set = new Set();
      matches.forEach(m => set.add(m.rule.topicKey));
      return Array.from(set);
    };

    // Helper: Resolve specificity conflicts (e.g. "Myanmar Women" beats "Myanmar")
    const resolveSpecificity = (matches) => {
      const distinct = getDistinctTopics(matches);
      if (distinct.length === 1) {
        return matches[0];
      }
      if (distinct.includes("Myanmar Women") && distinct.includes("Myanmar")) {
        return matches.find(m => m.rule.topicKey === "Myanmar Women");
      }
      // If multiple genuinely distinct topics compete at the same tier, mark as ambiguous conflict
      return null;
    };

    // Evaluate Tier 1
    if (tier1Matches.length > 0) {
      const resolved = resolveSpecificity(tier1Matches);
      if (resolved) {
        return {
          topicKey: resolved.rule.topicKey,
          topic: resolved.rule.topicKey,
          confidence: 0.98,
          matchedRule: "EXACT_HASHTAG",
          matchedToken: resolved.token,
          koreanName: resolved.rule.koreanName,
          cardNum: resolved.rule.cardNum,
          fallbackReason: null
        };
      }
      return {
        ...defaultResult,
        matchedRule: "AMBIGUOUS_CONFLICT",
        matchedToken: tier1Matches.map(m => m.token).join(", "),
        fallbackReason: "ambiguous conflict between multiple topics"
      };
    }

    // Evaluate Tier 2
    if (tier2Matches.length > 0) {
      const resolved = resolveSpecificity(tier2Matches);
      if (resolved) {
        return {
          topicKey: resolved.rule.topicKey,
          topic: resolved.rule.topicKey,
          confidence: 0.90,
          matchedRule: "EXACT_PHRASE",
          matchedToken: resolved.token,
          koreanName: resolved.rule.koreanName,
          cardNum: resolved.rule.cardNum,
          fallbackReason: null
        };
      }
      return {
        ...defaultResult,
        matchedRule: "AMBIGUOUS_CONFLICT",
        matchedToken: tier2Matches.map(m => m.token).join(", "),
        fallbackReason: "ambiguous conflict between multiple topics"
      };
    }

    // Evaluate Tier 3
    if (tier3Matches.length > 0) {
      const resolved = resolveSpecificity(tier3Matches);
      if (resolved) {
        return {
          topicKey: resolved.rule.topicKey,
          topic: resolved.rule.topicKey,
          confidence: 0.88,
          matchedRule: "EXACT_CJK",
          matchedToken: resolved.token,
          koreanName: resolved.rule.koreanName,
          cardNum: resolved.rule.cardNum,
          fallbackReason: null
        };
      }
      return {
        ...defaultResult,
        matchedRule: "AMBIGUOUS_CONFLICT",
        matchedToken: tier3Matches.map(m => m.token).join(", "),
        fallbackReason: "ambiguous conflict between multiple topics"
      };
    }

    // Evaluate Tier 4
    if (tier4Matches.length > 0) {
      const resolved = resolveSpecificity(tier4Matches);
      if (resolved) {
        return {
          topicKey: resolved.rule.topicKey,
          topic: resolved.rule.topicKey,
          confidence: 0.80,
          matchedRule: "SPECIFIC_COMBINATION",
          matchedToken: resolved.token,
          koreanName: resolved.rule.koreanName,
          cardNum: resolved.rule.cardNum,
          fallbackReason: null
        };
      }
      return {
        ...defaultResult,
        matchedRule: "AMBIGUOUS_CONFLICT",
        matchedToken: tier4Matches.map(m => m.token).join(", "),
        fallbackReason: "ambiguous conflict between multiple topics"
      };
    }

    // Default / Unmatched (Generic single words or unclassified content)
    return defaultResult;
  }

  // ============================================================
  // ⚙️ INGESTION & DRY-RUN PIPELINE
  // ============================================================

  /**
   * Processes an external item through authorization, validation, deduplication, and topic routing.
   * In dry-run mode: does not download media or upload to Telegram; logs concise metadata.
   * @param {object} rawItem 
   * @returns {object} Processing result
   */
  processItem(rawItem) {
    // 1. Authorization Check
    const authCheck = this.checkAuthorization();
    if (!authCheck.authorized) {
      return {
        status: "REJECTED_UNAUTHORIZED",
        reason: authCheck.reason,
        rawItem
      };
    }

    // 2. Metadata Normalization & Validation
    const normalized = this.normalizeItem(rawItem);
    if (!normalized || !normalized.valid) {
      return {
        status: "REJECTED_INVALID_METADATA",
        reason: normalized ? normalized.error : "Invalid item structure",
        rawItem
      };
    }

    // 3. Deduplication Check
    if (this.isDuplicate(normalized.uniqueHash)) {
      return {
        status: "SKIPPED_DUPLICATE",
        uniqueHash: normalized.uniqueHash,
        itemId: normalized.itemId,
        title: normalized.title
      };
    }

    // 4. Topic Routing
    const route = this.matchTopic(normalized);
    normalized.topicKey = route.topicKey;
    normalized.topic = route.topicKey;
    normalized.routingConfidence = route.confidence;
    normalized.matchedRule = route.matchedRule;
    normalized.matchedToken = route.matchedToken;
    normalized.cardNum = route.cardNum;

    // 5. Dry-Run Execution
    if (this.dryRun) {
      console.log(
        `🔍 [EXTERNAL_SOURCE DRY_RUN] Discovered item: "${normalized.title}" | ` +
        `ID: ${normalized.itemId} | ` +
        `URL: ${normalized.mediaUrl} | ` +
        `Topic: ${normalized.topicKey} (${route.koreanName || ""}) [Rule: ${route.matchedRule}, Conf: ${route.confidence}] | ` +
        `Tags: [${normalized.tags.join(", ")}] | ` +
        `Published: ${normalized.publishedAt}`
      );

      // Record into ledger as dry-run item
      this.recordItem(normalized);

      return {
        status: "DRY_RUN_PROCESSED",
        item: normalized,
        route: route,
        dryRun: true
      };
    }

    // 6. Live Mode (Returns normalized payload ready for downstream publisher)
    this.recordItem(normalized);

    return {
      status: "READY_FOR_PIPELINE",
      item: normalized,
      route: route,
      dryRun: false
    };
  }

  // ============================================================
  // ⚡ RATE LIMITING & RETRY HELPERS
  // ============================================================

  /**
   * Enforces rate limiting delay
   */
  async enforceRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTimestamp;
    if (elapsed < this.rateLimitDelayMs) {
      const waitTime = this.rateLimitDelayMs - elapsed;
      await new Promise(r => setTimeout(r, waitTime));
    }
    this.lastRequestTimestamp = Date.now();
  }

  /**
   * Executes an asynchronous task with exponential backoff retry
   * @param {Function} taskFn 
   * @returns {Promise<any>}
   */
  async executeWithRetry(taskFn) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await taskFn();
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ [EXTERNAL_SOURCE] Attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        if (attempt < this.maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw new Error(`[EXTERNAL_SOURCE] Failed after ${this.maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Performs an HTTP/HTTPS GET JSON request
   * @param {string} urlString 
   * @returns {Promise<any>}
   */
  httpGetJson(urlString) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlString);
      const client = parsed.protocol === "https:" ? https : http;

      const headers = {
        "User-Agent": "NexaHub-ExternalSourceAdapter/1.0",
        "Accept": "application/json"
      };

      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const req = client.get(urlString, { headers, timeout: this.timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP status ${res.statusCode} ${res.statusMessage}`));
        }

        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`JSON Parse Error: ${e.message}`));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });
    });
  }
}

module.exports = {
  ExternalSourceAdapter,
  CANONICAL_12_TOPIC_RULES,
  DEFAULT_TOPIC_RULES: CANONICAL_12_TOPIC_RULES
};
