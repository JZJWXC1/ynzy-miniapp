(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MockData = api;
  }
})(typeof window !== 'undefined' ? window : this, function () {
  var NO_FEATURE = '无';
  var NO_COMMISSION_FEATURE = '不分佣';
  var DEPOSIT_FREE_FEATURE = '免押金';
  var COMPANY_SOURCE = '公司房源';
  var V1_COMMISSION_TEXT = '管理员确认签单后，成交总比例按房东实付佣金的 20% 计算，上传人按房源类型到手';
  var OWNER_SOURCE = '业主房源';
  var SECOND_LANDLORD_SOURCE = '二房东房源';
  var BROKER_ROLE = '中介';
  var BROKER_AUTHED = '手机号登录';
  var VERIFY_STALE_DAYS = 7;
  var OWNER_DAILY_VIEW_LIMIT = 3;
  var NORMAL_DAILY_VIEW_LIMIT = 15;
  var FEATURE_INFERENCE_RULES = [
    { name: '带阳台', pattern: /阳台/ },
    { name: '干湿分离', pattern: /干湿分离/ },
    { name: '燃气', pattern: /燃气|天然气|煤气/ },
    { name: '带露台（阁楼）', pattern: /阁楼|露台|带露台/ },
    { name: '花园', pattern: /花园/ },
    { name: '近地铁', pattern: /近地铁|地铁口|地铁站|号线/ },
    { name: '朝南', pattern: /朝南|南向/ },
    { name: '独卫', pattern: /独卫|独立卫|独立厨卫|独厨独卫/ },
    { name: '电梯', pattern: /电梯/ },
    { name: '整租', pattern: /整租|（整）|\(整\)/ },
    { name: '合租', pattern: /合租|单间/ },
    { name: DEPOSIT_FREE_FEATURE, pattern: /免押金|无押金|零押金|押金0|押金为0/ }
  ];
  var LISTING_FEATURE_OPTIONS = [
    '带阳台',
    '带露台（阁楼）',
    '干湿分离',
    '燃气',
    '阁楼',
    '露台',
    '花园',
    '近地铁',
    '朝南',
    '独卫',
    '电梯',
    '整租',
    '合租',
    DEPOSIT_FREE_FEATURE,
    NO_COMMISSION_FEATURE,
    NO_FEATURE
  ];
  var communityCoordinates = {
    京漾东韵府: { latitude: 30.280809, longitude: 120.201453, source: 'lianjia-bd09-to-gcj02' },
    骏塘名庭: { latitude: 30.282157, longitude: 120.215869, source: 'lianjia-bd09-to-gcj02' },
    翰皋名府: { latitude: 30.280384, longitude: 120.211055, source: 'lianjia-bd09-to-gcj02' },
    皋塘运都: { latitude: 30.281799, longitude: 120.213997, source: 'hangzhou-rentals-amap' },
	    长木府: { latitude: 30.304535, longitude: 120.177467, source: 'lianjia-bd09-to-gcj02' },
	    长浜龙吟轩: { latitude: 30.309357, longitude: 120.184283, source: 'amap-poi-B0K6U5MNPA' },
	    香柠颜家府: { latitude: 30.307094, longitude: 120.176774, source: 'lianjia-bd09-to-gcj02' },
	    杨乐府: { latitude: 30.303432, longitude: 120.168634, source: 'lianjia-bd09-to-gcj02' },
	    长岳王马府: { latitude: 30.295281, longitude: 120.175526, source: 'lianjia-bd09-to-gcj02' },
	    兴业杨家府: { latitude: 30.32315, longitude: 120.198637, source: 'amap-poi-B0MA5XR20Z' },
	    杨家新雅苑: { latitude: 30.319816, longitude: 120.190283, source: 'amap-poi-B0MB4KYB67' },
	    琬秋铭府: { latitude: 30.287781, longitude: 120.196655, source: 'amap-poi-B0KKK5QPUI' },
	    华丰欣苑: { latitude: 30.337823, longitude: 120.200076, source: 'lianjia-bd09-to-gcj02' },
	    华丰新苑: { latitude: 30.338453, longitude: 120.199293, source: 'amap-poi-B0L6SY3412' },
	    石桥铭苑: { latitude: 30.332732, longitude: 120.190706, source: 'amap-poi-B0L16HRS32' },
	    永佳新苑: { latitude: 30.344938, longitude: 120.189903, source: 'lianjia-bd09-to-gcj02' },
	    永佳欣苑: { latitude: 30.344415, longitude: 120.189613, source: 'amap-poi-B0LB2ZPTD0' },
	    中融城市花园: { latitude: 30.272679, longitude: 120.128231, source: 'lianjia-bd09-to-gcj02' },
    大华海派风景: { latitude: 30.345286, longitude: 120.121984, source: 'lianjia-bd09-to-gcj02' },
    星桥锦绣嘉苑: { latitude: 30.330332, longitude: 120.113377, source: 'lianjia-bd09-to-gcj02' },
    孔家埭和府: { latitude: 30.330706, longitude: 120.098179, source: 'lianjia-bd09-to-gcj02' },
    合嵣悦府: { latitude: 30.357956, longitude: 120.071333, source: 'lianjia-bd09-to-gcj02' },
    臻棠樾府: { latitude: 30.328821, longitude: 120.151128, source: 'lianjia-bd09-to-gcj02' },
    万融城: { latitude: 30.333846, longitude: 120.127299, source: 'lianjia-bd09-to-gcj02' },
	    吉如家园: { latitude: 30.31814, longitude: 120.129706, source: 'lianjia-bd09-to-gcj02' },
	    棠润府: { latitude: 30.336618, longitude: 120.129081, source: 'lianjia-bd09-to-gcj02' },
	    白田畈龙吟府: { latitude: 30.300532, longitude: 120.191573, source: 'amap-poi-B0KDBHKX6N' },
	    嘉樘星绣府: { latitude: 30.317987, longitude: 120.184781, source: 'amap-poi-B0JKVRM87Y' },
	    嘉橖星绣府: { latitude: 30.317987, longitude: 120.184781, source: 'amap-poi-B0JKVRM87Y' },
	    小洋坝家园二区: { latitude: 30.347765, longitude: 120.102918, source: 'amap-poi-B0I637WD1Z' },
	    昌运里三区: { latitude: 30.342866, longitude: 120.131563, source: 'amap-poi-B0J6VZ5YOP' }
	  };

  function parseFeatureInput(value) {
    var source = Array.isArray(value) ? value : String(value || '').split(/[，,、|]/);
    var seen = {};
    return source.map(function (item) {
      return String(item || '').trim();
    }).filter(Boolean).filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function normalizeListingFeatures(value) {
    var selected = parseFeatureInput(value).filter(function (item) {
      return LISTING_FEATURE_OPTIONS.indexOf(item) !== -1;
    });
    var hasNoCommission = selected.indexOf(NO_COMMISSION_FEATURE) !== -1;
    var features = selected.filter(function (item) {
      return item !== NO_FEATURE && item !== NO_COMMISSION_FEATURE;
    });
    if (!features.length) return hasNoCommission ? [NO_COMMISSION_FEATURE] : [NO_FEATURE];
    return hasNoCommission ? features.concat(NO_COMMISSION_FEATURE) : features;
  }

  function invalidListingFeatures(value) {
    return parseFeatureInput(value).filter(function (item) {
      return LISTING_FEATURE_OPTIONS.indexOf(item) === -1;
    });
  }

  function featureText(value) {
    return normalizeListingFeatures(value).join(' · ');
  }

  function normalizeCommunityName(name) {
    return String(name || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^(杭州市?|杭州)?(上城区|拱墅区|西湖区|滨江区|萧山区|余杭区|临平区|钱塘区)/, '');
  }

  function coordinateByCommunity(name) {
    var key = String(name || '').trim();
    var coordinate = communityCoordinates[key];
    if (!coordinate) {
      var normalized = normalizeCommunityName(name);
      var matchedKey = Object.keys(communityCoordinates).sort(function (left, right) {
        return normalizeCommunityName(right).length - normalizeCommunityName(left).length;
      }).find(function (item) {
        var itemName = normalizeCommunityName(item);
        return normalized === itemName || normalized.indexOf(itemName) !== -1 || (normalized.length >= 3 && itemName.indexOf(normalized) !== -1);
      });
      key = matchedKey || '';
      coordinate = matchedKey ? communityCoordinates[matchedKey] : null;
    }
    if (!coordinate) return null;
    return {
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      source: coordinate.source,
      community: key
    };
  }

  var state = {
    currentUserId: 'U001',
    summary: {
      areaInventory: [
        { area: '滨江', count: 86 },
        { area: '萧山', count: 24 },
        { area: '上城', count: 18 }
      ],
      groupCount: 18,
      unlockedGroupCount: 9,
      userCount: 46,
      authedUsers: 42,
      todaySensitiveViews: 42
    },
    users: [
      { id: 'U001', name: '王晓', phone: '13800010001', role: '内部员工 · 房源上传人', authed: '已实名', isAdmin: false },
      { id: 'U002', name: '李明', phone: '13800010002', role: '内部员工 · 带看人', authed: '已实名', isAdmin: false },
      { id: 'U003', name: '陈晨', phone: '13800010003', role: '内部员工 · 群聊上传人', authed: '已实名', isAdmin: false },
      { id: 'U004', name: '张敏', phone: '13800010004', role: '区域主管', authed: '已实名', isAdmin: true },
      { id: 'U19941091943', name: '吴志坚', phone: '19941091943', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U18857026476', name: '吴彦祖', phone: '18857026476', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U19975390741', name: '吴尊', phone: '19975390741', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U005', name: '刘洋', phone: '13800010005', role: '内部员工', authed: '已实名', isAdmin: false },
      { id: 'U006', name: '赵一', phone: '13800010006', role: '内部员工', authed: '未实名', isAdmin: false }
    ],
    listings: [],
    listingMaintenanceRule: {
      enabled: false,
      remindDays: [3, 5],
      expireDays: VERIFY_STALE_DAYS,
      updatedAt: '',
      updatedBy: ''
    },
    groupUnlocks: [],
    groups: [
      { id: 'G1', name: '滨江急租群', count: 128, tag: '已加入', unlocked: true },
      { id: 'G2', name: '业主直租群', count: 86, tag: '消耗1积分解锁', unlocked: false },
      { id: 'G3', name: '公寓合作群', count: 64, tag: '消耗1积分解锁', unlocked: false },
      { id: 'G4', name: '萧山整租群', count: 52, tag: '消耗1积分解锁', unlocked: false }
    ],
    footprints: [],
    commissionRecords: [],
    pointLogs: [
      { id: 'P001', userId: 'U003', type: '群聊审核通过', change: 1, note: '滨江急租群核对通过，积分到账', time: '今天 15:12' },
      { id: 'P002', userId: 'U001', type: '积分充值', change: 5, note: '充值 100 元到账', time: '今天 13:05' },
      { id: 'P003', userId: 'U002', type: '换群', change: -1, note: '解锁业主直租群一次', time: '今天 14:51' },
      { id: 'P004', userId: 'U001', type: '普通上传', change: 0, note: '普通房源上传不加积分', time: '昨天 18:30' }
    ],
    rechargeBills: [
      { id: 'RC20260605001', userId: 'U001', points: 5, amount: 100, status: '已支付', pointGranted: true, time: '今天 13:05' },
      { id: 'RC20260605002', userId: 'U002', points: 2, amount: 40, status: '已支付', pointGranted: true, time: '今天 11:42' },
      { id: 'RC20260604006', userId: 'U003', points: 1, amount: 20, status: '待确认', pointGranted: false, time: '昨天 19:16' },
      { id: 'RC20260604002', userId: 'U006', points: 8, amount: 160, status: '已支付', pointGranted: true, time: '昨天 10:08' }
    ],
    groupUploads: [
      {
        id: 'GU001',
        userId: 'U003',
        groupId: 'G1',
        title: '滨江急租群',
        area: '滨江',
        block: '西兴',
        screenshotUrl: '',
        points: 1,
        pointGranted: true,
        status: '已通过',
        contactStatus: '已联系核对',
        reviewNote: '已联系上传人核对',
        time: '今天 15:12'
      }
    ],
    showingUploads: []
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i += 1) {
      var text = String(arguments[i] || '').trim();
      if (text) return text;
    }
    return '';
  }

  function firstOwnValue(source, fields) {
    var target = source || {};
    var field = fields.find(function (item) {
      return Object.prototype.hasOwnProperty.call(target, item);
    });
    return field ? target[field] : undefined;
  }

  function normalizeFormFeatures(form, current) {
    var featureFields = ['features', 'featureTags', 'tags'];
    var formValue = firstOwnValue(form, featureFields);
    var currentValue = firstOwnValue(current, featureFields);
    var value = formValue !== undefined ? formValue : currentValue;
    return {
      features: normalizeListingFeatures(value),
      hasFeatureInput: parseFeatureInput(value).length > 0,
      invalidFeatures: invalidListingFeatures(value)
    };
  }

  function formCompanyListing(form, current) {
    var flag = firstOwnValue(form, ['companyListing', 'isCompanyListing', 'companyOwned']);
    var source = firstText(form.source, form.sourceType, form.listingType, form.inventoryType);
    if (flag !== undefined) return truthyFlag(flag);
    if (source) return /公司房源|company/.test(source);
    return isCompanyListing(current || {});
  }

  function prepareSourceFields(form, current, rate, featureState) {
    var companyListing = formCompanyListing(form || {}, current || {});
    var ownerType = normalizeOwnerType(firstText((form || {}).ownerType, (form || {}).houseSourceType, (form || {}).landlordType, (current || {}).ownerType, (current || {}).houseSourceType), (current || {}).ownerType || SECOND_LANDLORD_SOURCE);
    var noCommission = companyListing || Number(rate) === 0 || parseFeatureInput((form || {}).features).indexOf(NO_COMMISSION_FEATURE) !== -1;
    var finalRate = noCommission ? 0 : rate;
    var features = featuresWithCompanyDefaults(featureState.features, {
      companyListing: companyListing,
      noCommission: noCommission,
      commissionRate: finalRate
    });
    return {
      companyListing: companyListing,
      noCommission: noCommission,
      commissionRate: finalRate,
      ownerType: ownerType,
      source: companyListing ? COMPANY_SOURCE : firstText((form || {}).source, (current || {}).source, ownerType),
      features: features,
      hasFeatureInput: featureState.hasFeatureInput || noCommission
    };
  }

  function normalizeCommunityReviewState(form, current) {
    var data = form || {};
    var saved = current || {};
    var communityMatchedInput = firstOwnValue(data, ['communityMatched', 'isCommunityMatched']);
    var manualReviewInput = firstOwnValue(data, ['requiresManualReview', 'manualReviewRequired']);
    var communityMatchStatusInput = firstText(data.communityMatchStatus, saved.communityMatchStatus);
    var hasCommunityReviewInput = communityMatchedInput !== undefined || manualReviewInput !== undefined || Object.prototype.hasOwnProperty.call(data, 'communityMatchStatus');
    var currentCommunityMatched = saved.communityMatched !== undefined
      ? truthyFlag(saved.communityMatched)
      : (saved.communityMatchStatus ? saved.communityMatchStatus !== '未匹配' : true);
    var communityMatched = communityMatchedInput !== undefined
      ? truthyFlag(communityMatchedInput)
      : (communityMatchStatusInput ? communityMatchStatusInput !== '未匹配' : currentCommunityMatched);
    var requiresManualReview = manualReviewInput !== undefined
      ? truthyFlag(manualReviewInput)
      : (hasCommunityReviewInput ? !communityMatched : truthyFlag(saved.requiresManualReview));
    var manualReviewReasonInput = firstText(data.manualReviewReason, saved.manualReviewReason);
    return {
      communityMatched: communityMatched,
      communityMatchStatus: communityMatched ? '已匹配' : '未匹配',
      requiresManualReview: requiresManualReview,
      manualReviewReason: requiresManualReview ? (manualReviewReasonInput || (!communityMatched ? '小区名称未匹配小区库' : '房源信息需人工审核')) : ''
    };
  }

  function normalizeDistrict(value) {
    var text = firstText(value);
    if (!text || text === '待分区') return text || '待分区';
    return text;
  }

  function normalizeHousePart(value, suffix) {
    var text = firstText(value);
    if (!text) return '';
    return text.slice(0 - suffix.length) === suffix ? text : text + suffix;
  }

  function buildStructuredAddress(fields) {
    return [
      fields.city,
      fields.area,
      fields.community,
      normalizeHousePart(fields.building, '栋'),
      normalizeHousePart(fields.unit, '单元'),
      normalizeHousePart(fields.roomNumber, '室')
    ].filter(Boolean).join('');
  }

  function buildLayoutFromFields(fields) {
    return [fields.rentMode, fields.room, fields.hall, fields.bath].filter(Boolean).join('');
  }

  function structuredLocation(listing) {
    var city = listing.city || '杭州';
    var area = normalizeDistrict(listing.district || listing.area || '待分区');
    return [city, area, listing.community || ''].filter(Boolean).join('');
  }

  function roomAddress(listing) {
    return [
      normalizeHousePart(listing.building, '栋'),
      normalizeHousePart(listing.unit, '单元'),
      normalizeHousePart(listing.roomNumber, '室')
    ].filter(Boolean).join('');
  }

  function listingLocationFields(listing) {
    var city = listing.city || '杭州';
    var area = normalizeDistrict(listing.district || listing.area || '待分区');
    return {
      city: city,
      district: area,
      area: area,
      block: listing.block || area || '待板块',
      community: listing.community || '',
      building: listing.building || '',
      unit: listing.unit || '',
      roomNumber: listing.roomNumber || '',
      locationSummary: structuredLocation(Object.assign({}, listing, { city: city, area: area })),
      roomAddress: roomAddress(listing)
    };
  }

  function getUser(id) {
    var userId = id || state.currentUserId;
    return state.users.find(function (user) {
      return user.id === userId;
    });
  }

  function loginByPhone(phone) {
    var target = String(phone || '').trim();
    if (!/^1\d{10}$/.test(target)) {
      throw new Error('请输入 11 位手机号');
    }
    var user = state.users.find(function (item) {
      return String(item.phone || '') === target;
    });
    if (!user) {
      var error = new Error('该手机号未开通内部中介账号，请联系管理员开通');
      error.statusCode = 403;
      throw error;
    }
    state.currentUserId = user.id;
    return clone(user);
  }

  function getListing(id) {
    return state.listings.find(function (listing) {
      return listing.id === id;
    });
  }

  function looksLikeVideoPath(value) {
    return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(value || '').trim());
  }

  function hasListingVideo(listing) {
    return looksLikeVideoPath(listing && listing.videoUrl) || looksLikeVideoPath(listing && listing.videoKey);
  }

  function isExpiredListing(listing) {
    return listing && (listing.lifecycleStatus === 'expired' || listing.status === '已失效' || listing.status === '已下架');
  }

  function normalizeOwnerType(value, fallback) {
    var text = String(value || '').trim();
    if (/业主/.test(text)) return OWNER_SOURCE;
    if (/二房东|二房東/.test(text)) return SECOND_LANDLORD_SOURCE;
    return fallback || SECOND_LANDLORD_SOURCE;
  }

  function isOwnerListing(listing) {
    var data = listing || {};
    var sourceText = [data.ownerType, data.houseSourceType, data.source, data.sourceType, data.listingType, data.category].map(function (item) {
      return String(item || '');
    }).join(' ');
    return normalizeOwnerType(data.ownerType || '') === OWNER_SOURCE || /业主/.test(sourceText);
  }

  function requiresListingReview(listing) {
    var data = listing || {};
    return Boolean(
      isOwnerListing(data) ||
      truthyFlag(data.requiresManualReview) ||
      truthyFlag(data.manualReviewRequired) ||
      data.communityMatchStatus === '未匹配' ||
      data.reviewStatus === '待审核' ||
      data.status === '待审核'
    );
  }

  function ownerReviewStatus(listing) {
    if (!requiresListingReview(listing)) return (listing || {}).reviewStatus || '无需审核';
    return (listing || {}).reviewStatus || ((listing || {}).status === '待审核' ? '待审核' : '已通过');
  }

  function isPendingOwnerReview(listing) {
    return requiresListingReview(listing) && ownerReviewStatus(listing) !== '已通过';
  }

  function rawActiveListings() {
    return state.listings.filter(function (listing) {
      return !isExpiredListing(listing);
    });
  }

  function activeListings() {
    autoExpireOverdueListings();
    return rawActiveListings();
  }

  function publicListings() {
    return activeListings().filter(function (listing) {
      return !isPendingOwnerReview(listing);
    });
  }

  function withListingNames(record) {
    var listing = getListing(record.listingId) || {};
    var viewer = getUser(record.viewerId) || {};
    var uploader = getUser(listing.uploaderId) || {};
    var isMine = record.viewerId === state.currentUserId;
    return {
      id: record.id,
      title: listing.title || '未知房源',
      status: record.action,
      customer: '查看人：' + (viewer.name || '未知') + ' · ' + (viewer.authed || '未实名'),
      time: record.time,
      price: listing.rent ? '¥' + listing.rent + '/月' : '',
      meta: '上传人：' + (uploader.name || '未知') + ' · ' + record.sync,
      direction: isMine ? '我查看的' : '我的房源被查看',
      raw: clone(record)
    };
  }

  function getUserPointBalance(userId) {
    var id = userId || state.currentUserId;
    return state.pointLogs.reduce(function (total, log) {
      if (log.userId !== id) return total;
      return total + log.change;
    }, 0);
  }

  function dateValue(text) {
    if (!text) return 0;
    if (text === '刚刚') return Date.now();
    var normalized = String(text).replace(/\//g, '-').replace(' ', 'T');
    var value = Date.parse(normalized);
    return Number.isFinite(value) ? value : 0;
  }

  function activeMaintenanceTime(listing) {
    var data = listing || {};
    var last = data.lastVerifiedAt || data.updatedAt || data.createdAt || '';
    if (last) return last;
    data.createdAt = '刚刚';
    data.lastVerifiedAt = '刚刚';
    return data.lastVerifiedAt;
  }

  function listingFreshness(listing) {
    if (isExpiredListing(listing)) {
      return {
        lastVerifiedAt: listing.lastVerifiedAt || '未核验',
        staleDays: listing.expiredStaleDays || 0,
        verifyStatus: '已下架',
        verifyTip: listing.expiredReason || ('超过 ' + VERIFY_STALE_DAYS + ' 天未电话联系房东确认房态'),
        needsVerify: false
      };
    }
    var last = activeMaintenanceTime(listing);
    var lastTime = dateValue(last);
    var staleDays = lastTime ? Math.max(0, Math.floor((Date.now() - lastTime) / 86400000)) : VERIFY_STALE_DAYS;
    var verifyStatus = '正常';
    var verifyTip = '最近 ' + staleDays + ' 天内已电话核验';
    if (!lastTime || staleDays >= VERIFY_STALE_DAYS) {
      verifyStatus = '需核验';
      verifyTip = !lastTime ? '未找到核验时间，请电话联系房东确认房态' : '已 ' + staleDays + ' 天未电话联系房东确认房态，规则开启时会自动下架';
    } else if (staleDays >= 5) {
      verifyStatus = '重点核验';
      verifyTip = '已 ' + staleDays + ' 天未电话联系房东确认，5 天提醒，请尽快更新';
    } else if (staleDays >= 3) {
      verifyStatus = '提醒核验';
      verifyTip = '已 ' + staleDays + ' 天未电话联系房东确认，3 天提醒';
    }
    return {
      lastVerifiedAt: last || '未核验',
      staleDays: staleDays,
      verifyStatus: verifyStatus,
      verifyTip: verifyTip,
      needsVerify: verifyStatus !== '正常'
    };
  }

  function maintenanceText(freshness) {
    var days = Number(freshness && freshness.staleDays);
    if (!Number.isFinite(days) || days >= VERIFY_STALE_DAYS) return VERIFY_STALE_DAYS + '天未维护';
    if (days <= 0) return '今日已维护';
    return days + '天前维护';
  }

  function truthyFlag(value) {
    return value === true || value === 1 || ['true', '1', 'yes', '是'].indexOf(String(value || '').trim().toLowerCase()) !== -1;
  }

  function isCompanyListing(listing) {
    var data = listing || {};
    var sourceText = [data.source, data.sourceType, data.listingType, data.inventoryType].map(function (item) {
      return String(item || '');
    }).join(' ');
    return Boolean(data.companyListing || data.isCompanyListing || truthyFlag(data.companyOwned) || /公司房源|company/.test(sourceText));
  }

  function isNoCommissionListing(listing) {
    var data = listing || {};
    return Boolean(isCompanyListing(data) || data.noCommission || Number(data.commissionRate) === 0 || parseFeatureInput(data.features).indexOf(NO_COMMISSION_FEATURE) !== -1);
  }

  function featuresWithNoCommission(value, listing) {
    var features = normalizeListingFeatures(value);
    if (!isNoCommissionListing(listing)) return features;
    var next = features.filter(function (item) {
      return item !== NO_FEATURE;
    });
    if (next.indexOf(NO_COMMISSION_FEATURE) === -1) next.push(NO_COMMISSION_FEATURE);
    return next.length ? next : [NO_COMMISSION_FEATURE];
  }

  function featuresWithCompanyDefaults(value, listing) {
    var data = listing || {};
    var companyListing = isCompanyListing(data) || data.companyListing;
    var features = featuresWithNoCommission(value, data).filter(function (item) {
      return item !== NO_FEATURE;
    });
    if (companyListing && features.indexOf(DEPOSIT_FREE_FEATURE) === -1) {
      features.push(DEPOSIT_FREE_FEATURE);
    }
    return features.length ? features : [NO_FEATURE];
  }

  function listingSourceFields(listing) {
    var data = listing || {};
    var companyListing = isCompanyListing(data);
    var noCommission = isNoCommissionListing(data);
    var ownerType = normalizeOwnerType(data.ownerType || data.houseSourceType || '', SECOND_LANDLORD_SOURCE);
    var reviewStatus = ownerReviewStatus(Object.assign({}, data, { ownerType: ownerType }));
    var sourceLabel = companyListing ? COMPANY_SOURCE : ownerType;
    return {
      companyListing: companyListing,
      isCompanyListing: companyListing,
      noCommission: noCommission,
      ownerType: ownerType,
      houseSourceType: ownerType,
      isOwnerListing: ownerType === OWNER_SOURCE,
      reviewStatus: reviewStatus,
      requiresManualReview: truthyFlag(data.requiresManualReview),
      manualReviewReason: data.manualReviewReason || '',
      communityMatched: data.communityMatched !== undefined ? truthyFlag(data.communityMatched) : data.communityMatchStatus !== '未匹配',
      communityMatchStatus: data.communityMatchStatus || (data.communityMatched === false ? '未匹配' : '已匹配'),
      sourceLabel: sourceLabel,
      commissionText: V1_COMMISSION_TEXT,
      commissionBadge: V1_COMMISSION_TEXT
    };
  }

  function uniqueTextList(values) {
    var seen = {};
    return (values || []).map(function (item) {
      return String(item || '').trim();
    }).filter(Boolean).filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function listingTextForFeatures(listing) {
    var data = listing || {};
    return [
      data.title,
      data.shortTitle,
      data.layout,
      data.type,
      data.rentMode,
      data.room,
      data.hall,
      data.bath,
      data.source,
      data.status,
      data.community,
      data.locationSummary,
      data.address
    ].map(function (item) {
      return String(item || '');
    }).join(' ');
  }

  function inferListingFeatures(listing) {
    var text = listingTextForFeatures(listing);
    var inferred = FEATURE_INFERENCE_RULES.filter(function (rule) {
      return rule.pattern.test(text);
    }).map(function (rule) {
      return rule.name;
    });
    if (/合租/.test(text) && inferred.indexOf('整租') !== -1) {
      inferred.splice(inferred.indexOf('整租'), 1);
    }
    return inferred;
  }

  function listingFeatureFields(listing) {
    var rawFeatures = parseFeatureInput((listing || {}).features);
    var shouldInfer = rawFeatures.indexOf(NO_FEATURE) === -1;
    var features = featuresWithCompanyDefaults((listing || {}).features, listing)
      .filter(function (item) {
        return item !== NO_FEATURE;
      })
      .concat(shouldInfer ? inferListingFeatures(listing) : []);
    if (isCompanyListing(listing) && features.indexOf(COMPANY_SOURCE) === -1) {
      features.unshift(COMPANY_SOURCE);
    }
    features = uniqueTextList(features).filter(function (item) {
      return item !== NO_COMMISSION_FEATURE;
    });
    if (!features.length) features = [NO_FEATURE];
    return {
      features: features,
      featureText: featureText(features)
    };
  }

  function listingDisplayFields(listing) {
    var freshness = listingFreshness(listing || {});
    return Object.assign({}, listingFeatureFields(listing), listingSourceFields(listing), {
      lastVerifiedAt: freshness.lastVerifiedAt,
      staleDays: freshness.staleDays,
      verifyStatus: freshness.verifyStatus,
      verifyTip: freshness.verifyTip,
      needsVerify: freshness.needsVerify,
      maintenanceText: maintenanceText(freshness)
    });
  }

  function listingMatchFeatureSet(listing) {
    return new Set(listingFeatureFields(listing).features
      .concat([listing && listing.rentMode, listing && listing.type])
      .filter(Boolean));
  }

  function relevanceLabel(score) {
    if (score >= 85) return '高相关';
    if (score >= 68) return '较相关';
    if (score >= 50) return '可参考';
    return '低相关';
  }

  function getAreaStats() {
    var statsMap = {};
    publicListings().forEach(function (listing) {
      var area = listing.area || '待分区';
      statsMap[area] = (statsMap[area] || 0) + 1;
    });
    return Object.keys(statsMap).map(function (area) {
      return { area: area, count: statsMap[area] };
    });
  }

  function getDashboardSummary() {
    var areaStats = getAreaStats();
    return {
      listingCount: areaStats.reduce(function (total, item) {
        return total + item.count;
      }, 0),
      areaStats: areaStats,
      staleListingCount: activeListings().filter(function (listing) {
        return listingFreshness(listing).needsVerify;
      }).length,
      expiredListingCount: state.listings.filter(isExpiredListing).length,
      groupCount: state.groups.length,
      unlockedGroupCount: state.groups.filter(function (group) {
        return group.unlocked;
      }).length,
      userCount: state.users.length,
      authedUsers: state.users.filter(function (user) {
        return user.authed === '已实名';
      }).length,
      todaySensitiveViews: state.footprints.filter(function (item) { return item.action !== '记录带看'; }).length,
      pendingShowingUploadCount: (state.showingUploads || []).filter(function (item) { return item.status === '待审核'; }).length
    };
  }

  function formatHomeListing(listing) {
    var uploader = getUser(listing.uploaderId) || {};
    var location = listingLocationFields(listing);
    var display = listingDisplayFields(listing);
    var publicTitle = listing.shortTitle || location.community || listing.community || ((location.area || '房源') + (listing.layout ? ' · ' + listing.layout : ''));
    return Object.assign({
      id: listing.id,
      title: publicTitle,
      meta: (location.locationSummary || location.area) + ' · ' + listing.layout + ' · 仅视频',
      sub: V1_COMMISSION_TEXT + ' · 上传人' + uploader.name,
      price: '¥' + listing.rent + '/月',
      tag: '签单后20%结算',
      videoUrl: listing.videoUrl || '',
      city: location.city,
      district: location.district,
      area: location.area,
      block: location.block,
      community: location.community,
      building: location.building,
      unit: location.unit,
      roomNumber: location.roomNumber,
      locationSummary: location.locationSummary,
      roomAddress: location.roomAddress
    }, display);
  }

  function matchesCategory(listing, category) {
    if (!category || category === '全部') return true;
    var display = listingDisplayFields(listing);
    var text = String((listing.type || '') + (listing.layout || '') + (listing.source || '') + (display.ownerType || '') + (display.sourceLabel || ''));
    if (category === '业主房源') return text.indexOf('业主') !== -1;
    return text.indexOf(category) !== -1;
  }

  function getListings(filter) {
    var query = filter || {};
    return publicListings().filter(function (listing) {
      var areaText = String((listing.city || '') + (listing.district || '') + (listing.area || '') + (listing.block || '') + (listing.community || '') + (listing.building || '') + (listing.unit || '') + (listing.roomNumber || '') + (listing.address || ''));
      if (!matchesCategory(listing, query.category)) return false;
      if (query.area && areaText.indexOf(query.area) === -1) return false;
      if (query.block && areaText.indexOf(query.block) === -1) return false;
      if (query.community && String(listing.community || '').indexOf(query.community) === -1) return false;
      if (query.layout && String(listing.layout || '').indexOf(query.layout) === -1) return false;
      if (query.rentMax && Number(listing.rent || 0) > Number(query.rentMax)) return false;
      return true;
    }).map(function (listing) {
      var row = formatHomeListing(listing);
      row.layout = listing.layout || '';
      row.rent = Number(listing.rent || 0);
      row.type = listing.type || '';
      row.rentMode = listing.rentMode || listing.type || '';
      row.room = listing.room || '';
      row.hall = listing.hall || '';
      row.bath = listing.bath || '';
      row.source = listing.source || '';
      row.status = listing.status || '';
      return row;
    });
  }

  function matchListings(condition) {
    var budget = Number(condition.budget || 0);
    var area = (condition.area || '').trim();
    var layout = (condition.layout || '').trim();
    var requestedFeatures = parseFeatureInput(condition.features).filter(function (item) {
      return item !== NO_FEATURE;
    });
    var hasCondition = budget || area || layout || requestedFeatures.length;
    var availableListings = publicListings();
    var scored = availableListings.map(function (listing) {
      var score = 40;
      var reasons = [];
      var featureSet = listingMatchFeatureSet(listing);
      var matchedFeatureCount = requestedFeatures.filter(function (item) {
        return featureSet.has(item);
      }).length;
      if (budget && listing.rent <= budget) {
        score += 24;
        reasons.push('预算匹配');
      }
      if (budget && listing.rent > budget) score -= Math.min(30, Math.ceil((listing.rent - budget) / 200));
      if (area && String((listing.city || '') + (listing.district || '') + (listing.area || '') + (listing.block || '') + (listing.community || '') + (listing.building || '') + (listing.unit || '') + (listing.roomNumber || '') + (listing.address || '')).indexOf(area) !== -1) {
        score += 24;
        reasons.push('区域匹配');
      }
      if (layout && listing.layout.indexOf(layout) !== -1) {
        score += 22;
        reasons.push('户型匹配');
      }
      if (requestedFeatures.length) {
        score += Math.min(30, matchedFeatureCount * 14);
        if (matchedFeatureCount) reasons.push('特点命中' + matchedFeatureCount + '项');
        if (!matchedFeatureCount) score -= 12;
      }
      if (listing.status === '在租') {
        score += 6;
        reasons.push('房态可租');
      }
      var relevanceScore = Math.max(1, Math.min(99, score));
      return {
        score: relevanceScore,
        reasons: reasons.length ? reasons : ['基础条件相近'],
        listing: listing
      };
    }).filter(function (item) {
      return !hasCondition || item.score >= 48;
    }).sort(function (a, b) {
      return b.score - a.score;
    });

    if (!scored.length && hasCondition) {
      return {
        summary: '暂未匹配到符合条件的房源，可调整预算、区域、户型或特点后再试。',
        listings: []
      };
    }

    var rows = scored.slice(0, 3).map(function (item) {
      var row = formatHomeListing(item.listing);
      row.relevanceScore = item.score;
      row.relevancePercent = item.score + '%';
      row.relevanceText = '相关性 ' + item.score + '%';
      row.relevanceLabel = relevanceLabel(item.score);
      row.relevanceReasons = item.reasons;
      row.matchScore = row.relevancePercent;
      row.tag = row.relevanceText;
      return row;
    });

    return {
      summary: '已从小程序房源库匹配到 ' + rows.length + ' 套，按相关性评分从高到低排序。',
      listings: rows
    };
  }

  function formatAdminListing(listing) {
    var uploader = getUser(listing.uploaderId) || {};
    var freshness = listingFreshness(listing);
    var display = listingDisplayFields(listing);
    var location = listingLocationFields(listing);
    var hasVideo = hasListingVideo(listing);
    return Object.assign({
      id: listing.id,
      title: listing.shortTitle,
      fullTitle: listing.title || listing.shortTitle || '',
      city: location.city,
      district: location.district,
      area: listing.area,
      block: listing.block,
      community: listing.community,
      building: location.building,
      unit: location.unit,
      roomNumber: location.roomNumber,
      locationSummary: location.locationSummary,
      roomAddress: location.roomAddress,
      address: listing.address || [location.locationSummary, location.roomAddress].filter(Boolean).join(''),
      uploader: uploader.name,
      uploaderPhone: uploader.phone || '',
      rent: listing.rent + '/月',
      rentValue: Number(listing.rent || 0),
      layout: listing.layout.replace('整租', ''),
      rawLayout: listing.layout || '',
      commission: V1_COMMISSION_TEXT,
      commissionRate: Number(listing.commissionRate || 0),
      source: listing.source || display.sourceLabel,
      video: hasVideo ? '已传' : '未传',
      videoUrl: listing.videoUrl || '',
      videoKey: listing.videoKey || '',
      videoLabel: listing.videoLabel || (hasVideo ? '房源视频' : ''),
      hasVideo: hasVideo,
      landlordPhone: listing.landlordPhone || listing.contact || '',
      contact: listing.landlordPhone || listing.contact || '',
      status: listing.status,
      type: listing.type || listing.rentMode || '',
      rentMode: listing.rentMode || listing.type || '',
      room: listing.room || '',
      hall: listing.hall || '',
      bath: listing.bath || '',
      features: display.features || [],
      tags: display.features || [],
      featureText: display.featureText || '',
      lastVerifiedAt: freshness.lastVerifiedAt,
      verifyStatus: freshness.verifyStatus,
      verifyTip: freshness.verifyTip,
      staleDays: freshness.staleDays,
      needsVerify: freshness.needsVerify,
      createdAt: listing.createdAt || '',
      updatedAt: listing.updatedAt || '',
      reviewNote: listing.reviewNote || '',
      expiredPool: listing.expiredPool || ''
    }, display);
  }

  function getListingDetail(id) {
    autoExpireOverdueListings();
    var listing = getListing(id);
    if (!listing) return null;
    if (isExpiredListing(listing) || isPendingOwnerReview(listing)) return null;
    var uploader = getUser(listing.uploaderId) || {};
    var location = listingLocationFields(listing);
    return Object.assign({
      id: listing.id,
      title: listing.title,
      uploader: uploader.name,
      rent: String(listing.rent),
      layout: listing.layout,
      city: location.city,
      district: location.district,
      area: location.area,
      areaText: location.city + ' · ' + location.area,
      block: location.block,
      community: location.community,
      building: location.building,
      unit: location.unit,
      roomNumber: location.roomNumber,
      locationSummary: location.locationSummary,
      roomAddress: location.roomAddress,
      address: '确认留痕后可查看',
      landlordPhone: '确认留痕后可查看',
      sensitiveLocked: true,
      commissionRate: listing.commissionRate,
      videoLabel: listing.videoLabel,
      videoUrl: listing.videoUrl || '',
      videoKey: listing.videoKey || '',
      type: listing.type || listing.rentMode || '',
      rentMode: listing.rentMode || listing.type || '',
      room: listing.room || '',
      hall: listing.hall || '',
      bath: listing.bath || '',
      status: listing.status
    }, listingDisplayFields(listing));
  }

  function getListingLogs(listingId) {
    return state.footprints.filter(function (item) {
      return item.listingId === listingId;
    }).map(function (item) {
      var user = getUser(item.viewerId) || {};
      return {
        user: user.name || '未知',
        action: item.action,
        needId: item.needId || '',
        purpose: item.purpose || '',
        time: item.time
      };
    });
  }

  function getFootprintRecords() {
    return state.footprints.map(withListingNames);
  }

  function getOwnedListings(userId) {
    var id = userId || state.currentUserId;
    return activeListings().filter(function (listing) {
      return listing.uploaderId === id;
    }).map(function (listing) {
      var location = listingLocationFields(listing);
      return Object.assign({
        id: listing.id,
        title: listing.title,
        city: location.city,
        district: location.district,
        area: location.area,
        block: location.block,
        community: location.community,
        building: location.building,
        unit: location.unit,
        roomNumber: location.roomNumber,
        locationSummary: location.locationSummary,
        roomAddress: location.roomAddress,
        rent: String(listing.rent),
        commissionRate: listing.commissionRate,
        commissionText: listingDisplayFields(listing).commissionText,
        noCommission: listingDisplayFields(listing).noCommission,
        companyListing: listingDisplayFields(listing).companyListing,
        sourceLabel: listingDisplayFields(listing).sourceLabel,
        views: listing.sensitiveViews + ' 次查看敏感信息'
      }, listingDisplayFields(listing));
    });
  }

  function getProfileState() {
    var user = getUser();
    var owned = getOwnedListings();
    var points = getUserPointBalance();
    var pendingCommission = state.commissionRecords.filter(function (item) {
      return item.uploaderId === state.currentUserId && item.status !== '已确认';
    }).length;
    var quota = brokerSensitiveUsage(state.currentUserId);
    return {
      user: clone(user),
      points: points,
      sourceStats: [
        { label: '已上架', value: String(owned.length) },
        { label: '积分', value: String(points) },
        { label: '待分佣', value: String(pendingCommission) },
        { label: '普通额度', value: quota.normalRemaining + '/' + quota.normalLimit }
      ],
      rechargeBills: state.rechargeBills.filter(function (bill) {
        return bill.userId === state.currentUserId;
      }).slice(0, 3).map(function (bill) {
        return {
          id: bill.id,
          points: bill.points + ' 分',
          amount: bill.amount + ' 元',
          status: bill.status,
          time: bill.time
        };
      }),
      reminders: [
        { title: '房态核验', value: owned.filter(function (item) { return item.needsVerify; }).length + ' 套房源需要电话核验' },
        { title: '敏感信息查看', value: state.footprints.filter(function (item) { return item.action !== '记录带看'; }).length + ' 条地址或电话查看足迹' },
        { title: '待确认分佣', value: pendingCommission + ' 单成交分佣待确认' }
      ]
    };
  }

  function getGroupState() {
    var unlockedMap = {};
    (state.groupUnlocks || []).forEach(function (item) {
      if (item.userId === state.currentUserId) unlockedMap[item.groupId] = true;
    });
    return {
      points: getUserPointBalance(),
      groups: state.groups.map(function (group) {
        var isDefaultJoined = group.unlocked === true && group.tag === '已加入';
        var unlocked = isDefaultJoined || Boolean(unlockedMap[group.id]);
        return {
          id: group.id,
          name: group.name,
          count: group.count + ' 套',
          tag: unlocked ? (isDefaultJoined ? group.tag : '本次已解锁') : '消耗 1 积分解锁',
          unlocked: unlocked
        };
      }),
      listings: publicListings().filter(function (listing) {
        return listing.source === '群聊上传';
      }).map(function (listing) {
        var uploader = getUser(listing.uploaderId) || {};
        return Object.assign({
          id: listing.id,
          title: listing.block + ' · ' + listing.layout,
          price: '¥' + listing.rent + '/月',
          rule: V1_COMMISSION_TEXT,
          publisher: uploader.name + ' · 已认证',
          status: listing.source === '群聊上传' ? '群聊上传房源' : '电话地址需实名查看'
        }, listingDisplayFields(listing));
      }),
      pointLogs: state.pointLogs.filter(function (log) {
        return log.userId === state.currentUserId || log.type === '群聊上传' || log.type === '换群';
      }).slice(0, 5).map(function (log) {
        return log.type + ' ' + (log.change > 0 ? '+' : '') + log.change + ' · ' + log.note;
      }),
      groupUploads: (state.groupUploads || []).filter(function (item) {
        return item.userId === state.currentUserId;
      }).slice(0, 3).map(function (item) {
        return {
          id: item.id,
          title: item.title,
          status: item.status || '待审核',
          point: item.pointGranted ? '+1 已到账' : '审核通过后到账',
          time: item.time
        };
      })
    };
  }

  var defaultMapCenter = {
    name: '东新园地铁口',
    latitude: 30.3192,
    longitude: 120.1694
  };

  function isDefaultMapCoordinate(latitude, longitude) {
    return Math.abs(latitude - defaultMapCenter.latitude) < 0.000001 &&
      Math.abs(longitude - defaultMapCenter.longitude) < 0.000001;
  }

  function explicitCoordinateFromSource(source) {
    var data = source || {};
    var latitude = Number(firstOwnValue(data, ['mapLatitude', 'latitude']));
    var longitude = Number(firstOwnValue(data, ['mapLongitude', 'longitude']));
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    return {
      latitude: latitude,
      longitude: longitude,
      source: data.coordinateSource || 'listing-coordinate'
    };
  }

  function listingMapCoordinateFields(community, form, current) {
    var communityCoordinate = coordinateByCommunity(community || (form || {}).community || (current || {}).community);
    if (communityCoordinate) {
      return {
        mapLatitude: communityCoordinate.latitude,
        mapLongitude: communityCoordinate.longitude,
        coordinateSource: communityCoordinate.source || 'community-coordinate'
      };
    }

    var formCoordinate = explicitCoordinateFromSource(form);
    if (formCoordinate) {
      return {
        mapLatitude: formCoordinate.latitude,
        mapLongitude: formCoordinate.longitude,
        coordinateSource: formCoordinate.source
      };
    }

    var currentCoordinate = explicitCoordinateFromSource(current);
    if (currentCoordinate && !isDefaultMapCoordinate(currentCoordinate.latitude, currentCoordinate.longitude)) {
      return {
        mapLatitude: currentCoordinate.latitude,
        mapLongitude: currentCoordinate.longitude,
        coordinateSource: currentCoordinate.source
      };
    }

    return {
      mapLatitude: defaultMapCenter.latitude,
      mapLongitude: defaultMapCenter.longitude,
      coordinateSource: 'default-center'
    };
  }

  function applyCommunityMapCoordinate(listing) {
    var coordinate = coordinateByCommunity((listing || {}).community);
    if (!coordinate) return null;
    listing.mapLatitude = coordinate.latitude;
    listing.mapLongitude = coordinate.longitude;
    listing.coordinateSource = coordinate.source || 'community-coordinate';
    return coordinate;
  }

  function mapCoordinateFromListing(listing) {
    var communityCoordinate = coordinateByCommunity((listing || {}).community);
    if (communityCoordinate) return communityCoordinate;

    var latitude = Number(listing.mapLatitude || listing.latitude);
    var longitude = Number(listing.mapLongitude || listing.longitude);
    if (isFinite(latitude) && isFinite(longitude)) {
      return { latitude: latitude, longitude: longitude, source: listing.coordinateSource || 'listing-coordinate' };
    }

    var left = isFinite(Number(listing.mapLeft)) ? Number(listing.mapLeft) : 50;
    var top = isFinite(Number(listing.mapTop)) ? Number(listing.mapTop) : 50;
    return {
      latitude: Number((defaultMapCenter.latitude + ((50 - top) / 50) * 0.035).toFixed(6)),
      longitude: Number((defaultMapCenter.longitude + ((left - 50) / 50) * 0.045).toFixed(6))
    };
  }

  function isSoldListing(listing) {
    var data = listing || {};
    return data.lifecycleStatus === 'sold' || /成交|签单/.test(String(data.status || ''));
  }

  function isMockFrontendEffectiveListing(listing) {
    return !isExpiredListing(listing) && !isSoldListing(listing) && hasListingVideo(listing) && !isPendingOwnerReview(listing);
  }

  function recommendationNowText() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
  }

  function recommendationText(value) {
    return String(value || '').trim();
  }

  function recommendationSensitiveFragments(listing) {
    var data = listing || {};
    return [
      data.address,
      data.landlordPhone,
      data.contact,
      data.customerPhone,
      data.clientPhone,
      data.idCard,
      data.identityNo,
      data.wechat,
      data.weixin,
      data.wx,
      data.videoUrl,
      data.videoSignedUrl,
      data.signedVideoUrl
    ].map(recommendationText).filter(function (item) {
      return item.length >= 4;
    });
  }

  function cleanRecommendationText(value, fragments) {
    var result = recommendationText(value);
    (fragments || []).forEach(function (fragment) {
      result = result.split(fragment).join('');
    });
    return result
      .replace(/https?:\/\/\S+/ig, '')
      .replace(/(?:微信|微 信|wx|wechat)[号號\s:：-]*[A-Za-z0-9_-]{4,}/ig, '')
      .replace(/1[3-9]\d{9}/g, '')
      .replace(/\b\d{17}[\dXx]\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function uniqueRecommendationValues(values) {
    var seen = {};
    return values.filter(function (value) {
      var item = recommendationText(value);
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function reliableRecommendationCoordinate(listing) {
    var data = listing || {};
    var communityCoordinate = coordinateByCommunity(data.community);
    if (communityCoordinate) {
      return {
        latitude: communityCoordinate.latitude,
        longitude: communityCoordinate.longitude,
        source: communityCoordinate.source || 'community-coordinate'
      };
    }
    var latitude = Number(data.mapLatitude || data.latitude);
    var longitude = Number(data.mapLongitude || data.longitude);
    var source = recommendationText(data.coordinateSource);
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    if (Math.abs(latitude - defaultMapCenter.latitude) < 0.000001 && Math.abs(longitude - defaultMapCenter.longitude) < 0.000001) return null;
    if (/^estimated-|^legacy-|default-center|listing-coordinate|area|hash|random|pending/i.test(source)) return null;
    if (!/lianjia|amap|community-coordinate|admin-verified-coordinate/i.test(source)) return null;
    return { latitude: latitude, longitude: longitude, source: source };
  }

  function recommendationCoordinateQuality(listing) {
    var data = listing || {};
    if (coordinateByCommunity(data.community)) return 'community_verified';
    var latitude = Number(data.mapLatitude || data.latitude);
    var longitude = Number(data.mapLongitude || data.longitude);
    var source = recommendationText(data.coordinateSource);
    if (!isFinite(latitude) || !isFinite(longitude)) return 'missing';
    if (Math.abs(latitude - defaultMapCenter.latitude) < 0.000001 && Math.abs(longitude - defaultMapCenter.longitude) < 0.000001) return 'missing';
    if (/^estimated-|^legacy-|default-center|listing-coordinate|area|hash|random|pending/i.test(source)) return 'unsafe_source';
    if (/community-coordinate|lianjia|amap/i.test(source)) return 'community_verified';
    if (/admin-verified-coordinate/i.test(source)) return 'admin_verified';
    return 'unverified';
  }

  function recommendationPublicLocation(listing, fragments) {
    var data = listing || {};
    var city = cleanRecommendationText(data.city || '杭州', fragments);
    var district = cleanRecommendationText(data.district || data.area || '待分区', fragments);
    var area = cleanRecommendationText(data.area || data.district || '待分区', fragments);
    var block = cleanRecommendationText(data.block || area || '待板块', fragments);
    var community = cleanRecommendationText(data.community || '', fragments);
    var coordinate = reliableRecommendationCoordinate(data);
    return {
      city: city,
      district: district,
      area: area,
      block: block,
      community: community,
      locationSummary: cleanRecommendationText([city, area, community].filter(Boolean).join(''), fragments),
      coordinate: coordinate ? {
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        source: cleanRecommendationText(coordinate.source, fragments)
      } : null
    };
  }

  function recommendationFreshnessScore(listing, generatedAt) {
    var data = listing || {};
    if (data.lifecycleStatus === 'expired' || data.lifecycleStatus === 'sold' || /已下架|已失效|已成交|签单/.test(String(data.status || ''))) return 0;
    var source = recommendationText(data.lastVerifiedAt || data.updatedAt || data.createdAt);
    if (!source || source === '刚刚') return 100;
    var timestamp = Date.parse(source);
    if (!isFinite(timestamp)) return 80;
    var now = Date.parse(generatedAt);
    if (!isFinite(now)) return 80;
    var days = Math.max(0, Math.floor((now - timestamp) / (24 * 60 * 60 * 1000)));
    return Math.max(0, Math.min(100, 100 - days * 14));
  }

  function recommendationPublicFields(listing, fragments) {
    var data = listing || {};
    var features = normalizeListingFeatures(data.features).map(function (item) {
      return cleanRecommendationText(item, fragments);
    }).filter(Boolean);
    return {
      publicLocation: recommendationPublicLocation(data, fragments),
      rent: isFinite(Number(data.rent || 0)) ? Number(data.rent || 0) : 0,
      layout: cleanRecommendationText(data.layout || '', fragments),
      rentMode: cleanRecommendationText(data.rentMode || data.type || '', fragments),
      room: cleanRecommendationText(data.room || '', fragments),
      hall: cleanRecommendationText(data.hall || '', fragments),
      bath: cleanRecommendationText(data.bath || '', fragments),
      features: features,
      featureText: cleanRecommendationText(featureText(features), fragments),
      coordinateQuality: recommendationCoordinateQuality(data),
      hasVideo: hasListingVideo(data)
    };
  }

  function recommendationSearchText(profile, fragments) {
    var location = profile.publicLocation || {};
    return cleanRecommendationText(uniqueRecommendationValues([
      location.city,
      location.district,
      location.area,
      location.block,
      location.community,
      location.locationSummary,
      profile.rent ? profile.rent + '元' : '',
      profile.layout,
      profile.rentMode,
      profile.room,
      profile.hall,
      profile.bath,
      profile.featureText,
      profile.hasVideo ? '有视频' : ''
    ]).join(' '), fragments);
  }

  function recommendationQualityScore(profile) {
    var score = 20;
    if (profile.publicLocation && profile.publicLocation.community) score += 15;
    if (Number(profile.rent || 0) > 0) score += 10;
    if (profile.layout || profile.room) score += 10;
    if ((profile.features || []).filter(function (item) { return item !== NO_FEATURE; }).length) score += 10;
    if (profile.hasVideo) score += 15;
    if (/verified/.test(profile.coordinateQuality || '')) score += 20;
    return Math.max(0, Math.min(100, score));
  }

  function buildRecommendationProfile(listing) {
    var generatedAt = recommendationNowText();
    var fragments = recommendationSensitiveFragments(listing);
    var fields = recommendationPublicFields(listing, fragments);
    var profile = Object.assign({
      ready: true,
      listingId: recommendationText((listing || {}).id),
      generatedAt: generatedAt
    }, fields, {
      searchText: '',
      qualityScore: 0,
      freshnessScore: recommendationFreshnessScore(listing, generatedAt),
      safetyVersion: 'recommendation-profile-v1',
      unavailableReason: ''
    });
    profile.searchText = recommendationSearchText(profile, fragments);
    profile.qualityScore = recommendationQualityScore(profile);
    return profile;
  }

  function buildUnavailableRecommendationProfile(listing, reason) {
    var generatedAt = recommendationNowText();
    var fragments = recommendationSensitiveFragments(listing);
    var fields = recommendationPublicFields(listing, fragments);
    return Object.assign({
      ready: false,
      listingId: recommendationText((listing || {}).id),
      generatedAt: generatedAt
    }, fields, {
      searchText: '',
      qualityScore: 0,
      freshnessScore: 0,
      safetyVersion: 'recommendation-profile-v1',
      unavailableReason: cleanRecommendationText(reason || 'not_frontend_effective', fragments)
    });
  }

  function refreshListingRecommendationProfile(listing) {
    if (!listing) return null;
    listing.recommendationProfile = buildRecommendationProfile(listing);
    return listing.recommendationProfile;
  }

  function clearListingRecommendationProfile(listing, reason) {
    if (!listing) return null;
    listing.recommendationProfile = buildUnavailableRecommendationProfile(listing, reason);
    return listing.recommendationProfile;
  }

  function recommendationUnavailableReason(listing, fallback) {
    var data = listing || {};
    if (isExpiredListing(data)) return 'expired';
    if (isSoldListing(data)) return 'sold';
    if (isPendingOwnerReview(data)) {
      if (data.reviewStatus === '已驳回' || data.status === '已驳回') return 'review_rejected';
      return 'pending_review';
    }
    if (!hasListingVideo(data)) return 'missing_video';
    return fallback || 'not_frontend_effective';
  }

  function syncListingRecommendationProfile(listing, reason) {
    if (!listing) return null;
    if (isMockFrontendEffectiveListing(listing)) return refreshListingRecommendationProfile(listing);
    return clearListingRecommendationProfile(listing, reason || recommendationUnavailableReason(listing));
  }

  function getMapPins() {
    return publicListings().map(function (listing) {
      var coordinate = mapCoordinateFromListing(listing);
      return Object.assign({
        id: listing.id,
        title: listing.shortTitle || listing.title,
        area: listing.area || '待分区',
        block: listing.block || '待板块',
        community: listing.community || '',
        layout: listing.layout || '',
        type: listing.type || '',
        status: listing.status || '',
        price: String(listing.rent),
        commission: V1_COMMISSION_TEXT,
        source: listing.source || '',
        companyListing: listingDisplayFields(listing).companyListing,
        noCommission: listingDisplayFields(listing).noCommission,
        sourceLabel: listingDisplayFields(listing).sourceLabel,
        commissionText: listingDisplayFields(listing).commissionText,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        coordinateSource: coordinate.source || '',
        left: listing.mapLeft,
        top: listing.mapTop
      }, listingDisplayFields(listing));
    });
  }

  function getAdminLogs() {
    return state.footprints.map(function (item) {
      var listing = getListing(item.listingId) || {};
      var viewer = getUser(item.viewerId) || {};
      var uploader = getUser(listing.uploaderId) || {};
      return {
        viewer: viewer.name,
        listing: listing.shortTitle,
        action: item.action,
        uploader: uploader.name,
        sync: item.sync,
        time: item.time
      };
    });
  }

  function getCommissionRows() {
    return state.commissionRecords.map(function (item) {
      var listing = getListing(item.listingId) || {};
      return {
        listing: listing.shortTitle,
        uploader: (getUser(item.uploaderId) || {}).name,
        dealer: (getUser(item.dealUserId) || {}).name,
        rate: (item.rate || 20) + '%',
        uploaderRate: item.uploaderRate === undefined ? 20 : item.uploaderRate,
        platformRate: item.platformRate || 0,
        landlordCommissionFen: item.landlordCommissionFen || 0,
        uploaderCommissionFen: item.uploaderCommissionFen || 0,
        platformCommissionFen: item.platformCommissionFen || 0,
        status: item.status,
        time: item.time
      };
    });
  }

  function getPointLogs() {
    return state.pointLogs.map(function (log) {
      return {
        user: (getUser(log.userId) || {}).name,
        type: log.type,
        change: (log.change > 0 ? '+' : '') + log.change,
        note: log.note,
        time: log.time
      };
    });
  }

  function getRechargeBills() {
    return state.rechargeBills.map(function (bill) {
      return {
        id: bill.id,
        user: (getUser(bill.userId) || {}).name,
        points: bill.points + ' 分',
        amount: bill.amount + ' 元',
        paymentMethod: bill.paymentMethod || (bill.status === '待确认' ? '后台人工确认' : '-'),
        outTradeNo: bill.outTradeNo || bill.id,
        status: bill.status,
        time: bill.time
      };
    });
  }

  function getGroupUploadRows() {
    return (state.groupUploads || []).map(function (item) {
      var uploader = getUser(item.userId) || {};
      return {
        id: item.id,
        title: item.title,
        area: item.area || '-',
        block: item.block || '-',
        uploader: uploader.name || '未知',
        uploaderPhone: uploader.phone || '-',
        screenshotUrl: item.screenshotUrl || '',
        contactStatus: item.contactStatus || '待联系核对',
        reviewNote: item.reviewNote || '',
        commission: V1_COMMISSION_TEXT,
        point: item.pointGranted ? '+1 已到账' : '审核通过后 +1',
        status: item.status || '待审核',
        time: item.time
      };
    });
  }

  function getShowingUploadRows() {
    return (state.showingUploads || []).map(function (item) {
      var listing = getListing(item.listingId) || {};
      var viewer = getUser(item.userId) || {};
      var reviewer = item.reviewerId ? (getUser(item.reviewerId) || {}) : {};
      var room = [listing.building, listing.unit, listing.roomNumber].filter(Boolean).join('-');
      return {
        id: item.id,
        listingId: item.listingId,
        listing: listing.title || item.listingTitle || '未知房源',
        listingTitle: listing.title || item.listingTitle || '未知房源',
        community: listing.community || item.community || '',
        room: room || '-',
        user: viewer.name || '未知',
        userPhone: viewer.phone || '-',
        uploader: listing.uploaderId ? ((getUser(listing.uploaderId) || {}).name || '未知') : '-',
        photoUrl: item.photoUrl || '',
        photoKey: item.photoKey || '',
        watermarkText: item.watermarkText || '',
        locationText: item.locationText || '',
        latitude: item.latitude || '',
        longitude: item.longitude || '',
        contactStatus: item.contactStatus || (item.status === '待审核' ? '待审核' : '已审核'),
        reviewNote: item.reviewNote || '',
        reviewer: reviewer.name || '',
        reward: item.rewardGranted ? ('普通房源额度 +' + (item.rewardCount || 1) + ' 已增加') : ('审核通过后普通房源额度 +' + (item.rewardCount || 1)),
        rewardGranted: Boolean(item.rewardGranted),
        status: item.status || '待审核',
        time: item.time,
        reviewedAt: item.reviewedAt || ''
      };
    });
  }

  function todayKey() {
    return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  }

  function isBrokerUser(user) {
    return user && !user.isAdmin && String(user.role || '').indexOf(BROKER_ROLE) !== -1;
  }

  function sensitiveQuotaCategory(listing, userId) {
    if (listing && listing.uploaderId === userId) return 'own';
    return isOwnerListing(listing || {}) ? 'owner' : 'normal';
  }

  function brokerSensitiveUsage(userId, date) {
    var targetDate = date || todayKey();
    var ownerIds = {};
    var normalIds = {};
    (state.footprints || []).forEach(function (record) {
      if (record.viewerId !== userId) return;
      if (record.action === '记录带看') return;
      if (record.dateKey && record.dateKey !== targetDate) return;
      if (!record.dateKey && record.time && record.time !== '刚刚' && String(record.time).indexOf(targetDate) === -1) return;
      var listing = getListing(record.listingId) || {};
      var category = record.quotaCategory || sensitiveQuotaCategory(listing, userId);
      if (category === 'owner') ownerIds[record.listingId] = true;
      if (category === 'normal') normalIds[record.listingId] = true;
    });
    var normalBonus = (state.showingUploads || []).filter(function (item) {
      return item.userId === userId && item.status === '已通过' && item.rewardGranted && (item.rewardDateKey || item.reviewedDateKey || item.dateKey) === targetDate;
    }).length;
    var ownerUsed = Object.keys(ownerIds).length;
    var normalUsed = Object.keys(normalIds).length;
    var normalLimit = NORMAL_DAILY_VIEW_LIMIT + normalBonus;
    return {
      date: targetDate,
      ownerUsed: ownerUsed,
      normalUsed: normalUsed,
      ownerLimit: OWNER_DAILY_VIEW_LIMIT,
      normalLimit: normalLimit,
      normalBonus: normalBonus,
      ownerRemaining: Math.max(0, OWNER_DAILY_VIEW_LIMIT - ownerUsed),
      normalRemaining: Math.max(0, normalLimit - normalUsed)
    };
  }

  function assertSensitiveViewAllowed(listing, payload) {
    var data = payload || {};
    var viewer = getUser() || {};
    var category = sensitiveQuotaCategory(listing || {}, state.currentUserId);
    if (!isBrokerUser(viewer) && viewer.authed !== '已实名') {
      var authError = new Error('查看地址和房东联系方式前需要先完成实名认证');
      authError.statusCode = 403;
      throw authError;
    }
    if (!(data.needId || data.rentalNeedId || data.clientNeedId)) {
      var needError = new Error('查看房源敏感信息必须绑定找房需求');
      needError.statusCode = 400;
      throw needError;
    }
    if (!(data.purpose || data.scene || data.reason)) {
      var purposeError = new Error('查看房源敏感信息必须填写查看用途');
      purposeError.statusCode = 400;
      throw purposeError;
    }
    var date = todayKey();
    var alreadyViewed = (state.footprints || []).some(function (record) {
      if (record.viewerId !== state.currentUserId || record.listingId !== (listing || {}).id) return false;
      if (record.action === '记录带看') return false;
      if (record.dateKey) return record.dateKey === date;
      return record.time === '刚刚' || String(record.time || '').indexOf(date) !== -1;
    });
    if (alreadyViewed) return { category: category, quota: brokerSensitiveUsage(state.currentUserId, date) };
    var quota = brokerSensitiveUsage(state.currentUserId, date);
    var limit = category === 'owner' ? quota.ownerLimit : quota.normalLimit;
    var used = category === 'owner' ? quota.ownerUsed : quota.normalUsed;
    if (used >= limit) {
      var quotaError = new Error('今日可查看额度已用完，如需继续查看，请联系管理员帮忙联系房东。');
      quotaError.statusCode = 403;
      quotaError.data = {
        quotaExceeded: true,
        quotaCategory: category,
        quota: quota
      };
      throw quotaError;
    }
    return { category: category, quota: quota };
  }

  function recordShowing(listingId, payload) {
    var data = payload || {};
    var listing = getListing(listingId);
    if (isExpiredListing(listing)) {
      throw new Error('该房源已下架，已进入后台废房源池');
    }
    if (isPendingOwnerReview(listing)) {
      throw new Error('该房源正在等待管理员审核，审核通过后才会上架');
    }
    if (!data.photoUrl && !data.photoKey) {
      throw new Error('记录带看必须上传带时间地点水印的现场照片');
    }
    var showing = {
      id: 'SH' + Date.now(),
      listingId: listingId,
      userId: state.currentUserId,
      listingTitle: listing ? (listing.title || listing.shortTitle || '') : '',
      community: listing ? (listing.community || '') : '',
      photoUrl: data.photoUrl || '',
      photoKey: data.photoKey || '',
      watermarkText: data.watermarkText || '',
      locationText: data.locationText || '',
      latitude: data.latitude || '',
      longitude: data.longitude || '',
      status: '待审核',
      contactStatus: '待审核',
      reviewNote: '',
      rewardCategory: 'normal',
      rewardCount: 1,
      rewardGranted: false,
      time: '刚刚',
      dateKey: todayKey()
    };
    state.showingUploads = state.showingUploads || [];
    state.showingUploads.unshift(showing);
    return {
      showing: clone(showing),
      logs: getListingLogs(listingId),
      quota: brokerSensitiveUsage(state.currentUserId),
      message: '带看水印照片已提交后台审核，审核通过后当天普通房源查看额度 +1'
    };
  }

  function maskedPhone(phone) {
    var text = String(phone || '');
    return text.length >= 11 ? text.slice(0, 3) + '****' + text.slice(-4) : text;
  }

  function getClientReports() {
    return (state.clientReports || []).filter(function (report) {
      return report.brokerId === state.currentUserId;
    }).map(function (report) {
      return Object.assign({}, report, {
        customerPhoneMasked: maskedPhone(report.customerPhone)
      });
    });
  }

  function createClientReport(listingId, payload) {
    var data = payload || {};
    var listing = getListing(listingId);
    if (!listing) throw new Error('未找到该房源');
    var phone = String(data.customerPhone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      throw new Error('客户手机号必填');
    }
    var needId = String(data.needId || data.rentalNeedId || data.clientNeedId || '').trim();
    if (!needId) {
      throw new Error('needId必填');
    }
    var now = new Date().toLocaleString('zh-CN', { hour12: false });
    var reportSnapshot = {
      needId: needId,
      listingId: listingId,
      brokerId: state.currentUserId,
      uploaderId: listing.uploaderId,
      listingTitle: listing.title || listing.shortTitle || '',
      community: listing.community || '',
      rentAtReport: listing.rent || '',
      rentFen: Math.round(Number(listing.rent || 0) * 100),
      source: listing.source || '',
      snapshotAt: now
    };
    state.clientReports = state.clientReports || [];
    var report = {
      id: 'CR' + Date.now(),
      needId: needId,
      listingId: listingId,
      listingTitle: listing.title || listing.shortTitle || '',
      community: listing.community || '',
      brokerId: state.currentUserId,
      uploaderId: listing.uploaderId,
      snapshotAt: now,
      reportSnapshot: reportSnapshot,
      customerName: String(data.customerName || '').trim(),
      customerPhone: phone,
      customerPhoneMasked: maskedPhone(phone),
      status: '已报备',
      dealId: '',
      createdAt: now
    };
    state.clientReports.unshift(report);
    return {
      message: '报备已创建',
      report: Object.assign({}, report)
    };
  }

  function getDealRecords() {
    return (state.dealRecords || []).filter(function (deal) {
      return deal.brokerId === state.currentUserId;
    }).map(clone);
  }

  function yuanToFen(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.round(number * 100);
  }

  function createDealFromReport(reportId, payload) {
    var data = payload || {};
    var report = (state.clientReports || []).find(function (item) { return item.id === reportId; });
    if (!report) throw new Error('未找到报备记录');
    if (report.brokerId !== state.currentUserId) throw new Error('只能从自己的报备记录发起签单');
    if (report.dealId) throw new Error('该报备已发起签单');
    var listing = getListing(report.listingId);
    if (!listing) throw new Error('未找到该房源');
    var monthlyRentFen = yuanToFen(data.monthlyRent || data.dealMonthlyRent);
    var landlordCommissionFen = yuanToFen(data.landlordCommission || data.landlordPaidCommission);
    if (!monthlyRentFen || !landlordCommissionFen) {
      throw new Error('成交月租和房东实际支付佣金必填');
    }
    state.dealRecords = state.dealRecords || [];
    var deal = {
      id: 'D' + Date.now(),
      reportId: reportId,
      listingId: report.listingId,
      listingTitle: report.listingTitle,
      community: report.community,
      brokerId: state.currentUserId,
      uploaderId: listing.uploaderId,
      dealMonthlyRentFen: monthlyRentFen,
      landlordCommissionFen: landlordCommissionFen,
      remark: String(data.remark || '').trim(),
      status: '待管理员确认',
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    };
    state.dealRecords.unshift(deal);
    report.dealId = deal.id;
    report.status = '已提交签单';
    clearListingRecommendationProfile(listing, 'deal_pending');
    return {
      message: '签单已提交，待管理员确认后生成分佣',
      deal: Object.assign({}, deal)
    };
  }

  function addSensitiveFootprint(listingId, payload) {
    var data = typeof payload === 'object' && payload ? payload : { action: payload };
    var listing = getListing(listingId);
    if (isExpiredListing(listing)) {
      throw new Error('该房源已下架，已进入后台废房源池');
    }
    if (isPendingOwnerReview(listing)) {
      throw new Error('该房源正在等待管理员审核，审核通过后才会上架');
    }
    var access = assertSensitiveViewAllowed(listing, data);
    var id = 'F' + Date.now();
    state.footprints.unshift({
      id: id,
      listingId: listingId,
      viewerId: state.currentUserId,
      action: data.action || '查看地址和电话',
      needId: data.needId || data.rentalNeedId || data.clientNeedId || '',
      purpose: data.purpose || data.scene || data.reason || '',
      time: '刚刚',
      dateKey: todayKey(),
      quotaCategory: access.category,
      sync: '已同步上传人'
    });
    if (listing) {
      listing.sensitiveViews += 1;
    }
    var location = listing ? listingLocationFields(listing) : {};
    return {
      logs: getListingLogs(listingId),
      sensitive: listing ? {
        city: location.city,
        district: location.district,
        area: location.area,
        areaText: location.city + ' · ' + location.area,
        block: location.block,
        community: location.community,
        building: location.building,
        unit: location.unit,
        roomNumber: location.roomNumber,
        locationSummary: location.locationSummary,
        roomAddress: location.roomAddress,
        address: listing.address,
        landlordPhone: listing.landlordPhone,
        sensitiveLocked: false
      } : {},
      quota: brokerSensitiveUsage(state.currentUserId)
    };
  }

  function recordVideoShare(listingId, payload) {
    var data = payload || {};
    var listing = getListing(listingId);
    var user = getUser();
    if (!user) {
      throw new Error('请先登录内部中介账号');
    }
    if (!listing || isExpiredListing(listing)) {
      throw new Error('房源不存在或已下架');
    }
    if (isPendingOwnerReview(listing)) {
      throw new Error('该房源正在等待管理员审核，审核通过后才会上架');
    }
    if (!hasListingVideo(listing)) {
      throw new Error('该房源暂无可转发视频');
    }
    var location = publicListingLocationFields(listing);
    var title = publicListingTitle(listing, location) || listing.shortTitle || '房源视频';
    state.footprints.unshift({
      id: 'F' + Date.now(),
      listingId: listingId,
      viewerId: user.id,
      action: '转发房间视频给租客',
      needId: data.needId || data.rentalNeedId || '',
      purpose: data.purpose || '推荐房源视频',
      time: '刚刚',
      dateKey: todayKey(),
      shareChannel: data.channel || 'wechat',
      shareTarget: data.target || 'tenant',
      sharePath: data.sharePath || '',
      sync: '已记录视频转发，便于推荐追踪'
    });
    return {
      message: '视频转发已留痕',
      share: {
        listingId: listingId,
        title: title,
        shareTitle: data.shareTitle || ('推荐你看这套房：' + title),
        sharePath: data.sharePath || '',
        broker: user.name || '中介',
        time: '刚刚'
      },
      logs: getListingLogs(listingId)
    };
  }

  function rechargePoints(points) {
    var count = Math.max(1, Math.floor(Number(points) || 1));
    var amount = count * 20;
    var bill = {
      id: 'RC' + Date.now(),
      userId: state.currentUserId,
      points: count,
      amount: amount,
      status: '待确认',
      pointGranted: false,
      paymentMethod: '后台人工确认',
      time: '刚刚'
    };
    state.rechargeBills.unshift(bill);
    return getProfileState();
  }

  function reviewRechargeBill(id, action) {
    var bill = state.rechargeBills.find(function (item) {
      return item.id === id;
    });
    if (!bill || bill.status !== '待确认') return getRechargeBills();

    var approved = action === 'approve' || action === '已确认到账';
    bill.status = approved ? '已确认到账' : '已驳回';
    bill.reviewedAt = '刚刚';
    bill.reviewNote = approved ? '管理员确认收款，积分到账' : '管理员驳回充值申请';

    if (approved && !bill.pointGranted) {
      bill.pointGranted = true;
      state.pointLogs.unshift({
        id: 'P' + Date.now(),
        userId: bill.userId,
        type: '积分充值',
        change: Number(bill.points || 0),
        note: '充值 ' + bill.amount + ' 元管理员确认到账',
        time: '刚刚'
      });
    }

    if (!approved) {
      bill.pointGranted = false;
      state.pointLogs.unshift({
        id: 'P' + Date.now(),
        userId: state.currentUserId,
        type: '充值审核',
        change: 0,
        note: bill.id + ' 已驳回，积分未到账',
        time: '刚刚'
      });
    }
    return getRechargeBills();
  }

  function uploadGroupListing(form) {
    var data = form || {};
    state.groupUploads = state.groupUploads || [];
    state.groupUploads.unshift({
      id: 'GU' + Date.now(),
      userId: state.currentUserId,
      groupId: data.groupId || 'G1',
      title: data.title || '群聊房源信息',
      area: data.area || '',
      block: data.block || '',
      screenshotUrl: data.screenshotUrl || '',
      screenshotKey: data.screenshotKey || '',
      points: 1,
      pointGranted: false,
      status: '待审核',
      contactStatus: '待联系核对',
      time: '刚刚'
    });
    return getGroupState();
  }

  function reviewShowingUpload(id, action) {
    var showing = (state.showingUploads || []).find(function (item) {
      return item.id === id;
    });
    if (!showing) return getShowingUploadRows();
    var approved = action === 'approve' || action === '已通过';
    showing.status = approved ? '已通过' : '已驳回';
    showing.contactStatus = approved ? '已审核通过' : '已审核驳回';
    showing.reviewNote = approved ? '水印照片核验通过，普通房源额度 +1' : '水印照片未通过核验';
    showing.reviewerId = state.currentUserId;
    showing.reviewedAt = '刚刚';
    showing.reviewedDateKey = todayKey();
    if (approved && !showing.rewardGranted) {
      showing.rewardGranted = true;
      showing.rewardDateKey = todayKey();
      showing.rewardCount = Number(showing.rewardCount || 1);
      state.footprints.unshift({
        id: 'F' + Date.now(),
        listingId: showing.listingId,
        viewerId: showing.userId,
        action: '记录带看',
        time: '刚刚',
        dateKey: todayKey(),
        showingUploadId: showing.id,
        proofStatus: '已通过',
        sync: '已同步上传人和管理员'
      });
    }
    state.pointLogs.unshift({
      id: 'P' + Date.now(),
      userId: state.currentUserId,
      type: '带看审核',
      change: 0,
      note: (showing.listingTitle || showing.listingId) + ' ' + showing.status + (approved ? '，普通房源额度 +1' : ''),
      time: '刚刚'
    });
    return getShowingUploadRows();
  }

  function unlockGroup(groupId) {
    var group = state.groups.find(function (item) {
      return item.id === groupId;
    });
    if (!group) return { ok: false, message: '未找到该群', data: getGroupState() };
    var isDefaultJoined = group.unlocked === true && group.tag === '已加入';
    var alreadyUnlocked = (state.groupUnlocks || []).some(function (item) {
      return item.userId === state.currentUserId && item.groupId === groupId;
    });
    if (isDefaultJoined || alreadyUnlocked) return { ok: false, message: '该群已解锁', data: getGroupState() };
    if (getUserPointBalance() <= 0) {
      return { ok: false, message: '积分不足，群聊审核通过或充值后可获得积分', data: getGroupState() };
    }
    state.groupUnlocks = state.groupUnlocks || [];
    state.groupUnlocks.unshift({
      id: 'GUO' + Date.now(),
      userId: state.currentUserId,
      groupId: groupId,
      groupName: group.name,
      time: '刚刚'
    });
    state.pointLogs.unshift({
      id: 'P' + Date.now(),
      userId: state.currentUserId,
      type: '换群',
      change: -1,
      note: '解锁' + group.name + '一次',
      time: '刚刚'
    });
    return { ok: true, message: '已消耗1积分换群', data: getGroupState() };
  }

  function addNormalListing(form) {
    var rate = form.commissionRate === '' ? 20 : Number(form.commissionRate);
    var id = 'L' + Date.now();
    var city = firstText(form.city, '杭州');
    var area = normalizeDistrict(firstText(form.district, form.area, '拱墅区'));
    var rawCommunity = firstText(form.communityName, form.community);
    var community = rawCommunity || '待补充';
    var building = firstText(form.building, form.buildingNo, form.buildingNumber);
    var unit = firstText(form.unit, form.unitNo, form.unitNumber);
    var roomNumber = firstText(form.roomNumber, form.roomNo, form.houseNo, form.doorNo);
    var rentMode = firstText(form.rentMode, form.type, '整租');
    var room = firstText(form.room, form.bedroom, form.bedrooms);
    var hall = firstText(form.hall, form.livingRoom, form.livingRooms);
    var bath = firstText(form.bath, form.bathroom, form.bathrooms);
    var address = firstText(form.address, buildStructuredAddress({ city: city, area: area, community: community, building: building, unit: unit, roomNumber: roomNumber }));
    var layout = firstText(form.layout, buildLayoutFromFields({ rentMode: rentMode, room: room, hall: hall, bath: bath }));
    var featureState = normalizeFormFeatures(form, {});
    var sourceState = prepareSourceFields(form, {}, rate, featureState);
    var communityReview = normalizeCommunityReviewState(form, {});
    var needsReview = sourceState.ownerType === OWNER_SOURCE || communityReview.requiresManualReview;
    var mapCoordinate = listingMapCoordinateFields(community, form, {});
    if (!address || !form.contact || !form.rent || !layout || !hasListingVideo(form) || !rawCommunity || !building || !roomNumber) {
      throw new Error('城市、区域、小区、几栋、房间号、联系方式、租金、户型和视频必填');
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
      throw new Error('结算规则已固定为上传人按房东实付佣金的 20%，当前历史佣金字段取值异常');
    }
    if (sourceState.companyListing && !(getUser() || {}).isAdmin) {
      throw new Error('只有管理员可以上传或标记公司房源');
    }
    if (!sourceState.hasFeatureInput) {
      throw new Error('请选择房源特点标签，若没有特点请选择“无”');
    }
    if (featureState.invalidFeatures.length) {
      throw new Error('房源特点标签无效：' + featureState.invalidFeatures.join('、'));
    }
    var listing = {
      id: id,
      title: address + ' · ' + layout,
      shortTitle: community || address,
      uploaderId: state.currentUserId,
      rent: Number(form.rent),
      layout: layout,
      city: city,
      district: area,
      area: area,
      block: form.block || area,
      community: community,
      building: building,
      unit: unit,
      roomNumber: roomNumber,
      address: address,
      landlordPhone: form.contact,
      commissionRate: sourceState.commissionRate,
      videoLabel: '新上传房源视频',
      videoUrl: form.videoUrl || '',
      videoKey: form.videoKey || '',
      status: needsReview ? '待审核' : '待确认',
      reviewStatus: needsReview ? '待审核' : '无需审核',
      communityMatched: communityReview.communityMatched,
      communityMatchStatus: communityReview.communityMatchStatus,
      requiresManualReview: communityReview.requiresManualReview,
      manualReviewReason: communityReview.manualReviewReason,
      lifecycleStatus: 'active',
      ownerType: sourceState.ownerType,
      houseSourceType: sourceState.ownerType,
      type: rentMode,
      rentMode: rentMode,
      room: room,
      hall: hall,
      bath: bath,
      features: sourceState.features,
      source: sourceState.source,
      companyListing: sourceState.companyListing,
      isCompanyListing: sourceState.companyListing,
      noCommission: sourceState.noCommission,
      sensitiveViews: 0,
      mapLeft: 50,
      mapTop: 50,
      mapLatitude: mapCoordinate.mapLatitude,
      mapLongitude: mapCoordinate.mapLongitude,
      coordinateSource: mapCoordinate.coordinateSource,
      createdAt: '刚刚',
      lastVerifiedAt: '刚刚'
    };
    state.listings.unshift(listing);
    syncListingRecommendationProfile(listing, needsReview ? 'pending_review' : '');
    state.pointLogs.unshift({
      id: 'P' + Date.now(),
      userId: state.currentUserId,
      type: '普通上传',
      change: 0,
      note: '普通房源上传不加积分',
      time: '刚刚'
    });
    return getEditableListing(id);
  }

  function getEditableListing(id) {
    var listing = getListing(id);
    if (!listing) return null;
    var location = listingLocationFields(listing);
    var display = listingDisplayFields(listing);
    return Object.assign({
      id: listing.id,
      title: listing.title,
      rent: String(listing.rent || ''),
      layout: listing.layout || '',
      city: location.city,
      district: location.district,
      area: location.area,
      block: location.block,
      community: location.community,
      building: location.building,
      unit: location.unit,
      roomNumber: location.roomNumber,
      address: listing.address || '',
      contact: listing.landlordPhone || '',
      landlordPhone: listing.landlordPhone || '',
      commissionRate: listing.commissionRate,
      videoLabel: listing.videoLabel || '房源实拍视频',
      videoUrl: listing.videoUrl || '',
      videoKey: listing.videoKey || '',
      status: listing.status || '',
      reviewStatus: listing.reviewStatus || '',
      communityMatched: listing.communityMatched !== undefined ? truthyFlag(listing.communityMatched) : listing.communityMatchStatus !== '未匹配',
      communityMatchStatus: listing.communityMatchStatus || (listing.communityMatched === false ? '未匹配' : '已匹配'),
      requiresManualReview: truthyFlag(listing.requiresManualReview),
      manualReviewReason: listing.manualReviewReason || '',
      type: listing.type || listing.rentMode || '',
      rentMode: listing.rentMode || listing.type || '',
      room: listing.room || '',
      hall: listing.hall || '',
      bath: listing.bath || ''
    }, display);
  }

  function updateNormalListing(id, form) {
    var listing = getListing(id);
    if (!listing) throw new Error('未找到该房源');
    var city = firstText(form.city, listing.city, '杭州');
    var area = normalizeDistrict(firstText(form.district, form.area, listing.district, listing.area, '拱墅区'));
    var community = firstText(form.communityName, form.community, listing.community);
    var building = firstText(form.building, form.buildingNo, form.buildingNumber, listing.building);
    var unit = firstText(form.unit, form.unitNo, form.unitNumber, listing.unit);
    var roomNumber = firstText(form.roomNumber, form.roomNo, form.houseNo, form.doorNo, listing.roomNumber);
    var rentMode = firstText(form.rentMode, form.type, listing.rentMode, listing.type, '整租');
    var room = firstText(form.room, form.bedroom, form.bedrooms, listing.room);
    var hall = firstText(form.hall, form.livingRoom, form.livingRooms, listing.hall);
    var bath = firstText(form.bath, form.bathroom, form.bathrooms, listing.bath);
    var address = firstText(form.address, buildStructuredAddress({ city: city, area: area, community: community, building: building, unit: unit, roomNumber: roomNumber }), listing.address);
    var layout = firstText(form.layout, buildLayoutFromFields({ rentMode: rentMode, room: room, hall: hall, bath: bath }), listing.layout);
    var rate = form.commissionRate === '' || form.commissionRate === undefined ? listing.commissionRate : Number(form.commissionRate);
    var featureState = normalizeFormFeatures(form, listing);
    var sourceState = prepareSourceFields(form, listing, rate, featureState);
    var communityReview = normalizeCommunityReviewState(form, listing);
    var mapCoordinate = listingMapCoordinateFields(community, form, listing);
    if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
      throw new Error('结算规则已固定为上传人按房东实付佣金的 20%，当前历史佣金字段取值异常');
    }
    if (sourceState.companyListing && !(getUser() || {}).isAdmin) {
      throw new Error('只有管理员可以上传或标记公司房源');
    }
    if (!sourceState.hasFeatureInput) {
      throw new Error('请选择房源特点标签，若没有特点请选择“无”');
    }
    if (featureState.invalidFeatures.length) {
      throw new Error('房源特点标签无效：' + featureState.invalidFeatures.join('、'));
    }
    listing.title = address + ' · ' + layout;
    listing.shortTitle = community || address;
    listing.rent = Number(firstText(form.rent, listing.rent));
    listing.layout = layout;
    listing.city = city;
    listing.district = area;
    listing.area = area;
    listing.block = Object.prototype.hasOwnProperty.call(form, 'block') ? form.block : (listing.block || area);
    listing.community = community;
    listing.building = building;
    listing.unit = unit;
    listing.roomNumber = roomNumber;
    listing.address = address;
    listing.landlordPhone = firstText(form.contact, form.landlordPhone, listing.landlordPhone);
    listing.commissionRate = sourceState.commissionRate;
    listing.videoUrl = firstText(form.videoUrl, listing.videoUrl);
    listing.videoKey = firstText(form.videoKey, listing.videoKey);
    listing.ownerType = sourceState.ownerType;
    listing.houseSourceType = sourceState.ownerType;
    listing.type = rentMode;
    listing.rentMode = rentMode;
    listing.room = room;
    listing.hall = hall;
    listing.bath = bath;
    listing.features = sourceState.features;
    listing.source = sourceState.source;
    listing.companyListing = sourceState.companyListing;
    listing.isCompanyListing = sourceState.companyListing;
    listing.noCommission = sourceState.noCommission;
    listing.communityMatched = communityReview.communityMatched;
    listing.communityMatchStatus = communityReview.communityMatchStatus;
    listing.requiresManualReview = communityReview.requiresManualReview;
    listing.manualReviewReason = communityReview.manualReviewReason;
    listing.mapLatitude = mapCoordinate.mapLatitude;
    listing.mapLongitude = mapCoordinate.mapLongitude;
    listing.coordinateSource = mapCoordinate.coordinateSource;
    var needsReview = sourceState.ownerType === OWNER_SOURCE || communityReview.requiresManualReview;
    if (needsReview) {
      listing.reviewStatus = listing.reviewStatus === '已通过' && !communityReview.requiresManualReview ? '已通过' : '待审核';
      if (listing.reviewStatus !== '已通过') listing.status = '待审核';
    } else {
      listing.reviewStatus = '无需审核';
      if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认';
    }
    syncListingRecommendationProfile(listing, needsReview && listing.reviewStatus !== '已通过' ? 'pending_review' : '');
    return getEditableListing(id);
  }

  function verifyMyListing(id) {
    var listing = getListing(id);
    if (listing && !isExpiredListing(listing)) {
      listing.status = '在租';
      listing.lifecycleStatus = 'active';
      listing.lastVerifiedAt = '刚刚';
      syncListingRecommendationProfile(listing);
    }
    return getOwnedListings();
  }

  function verifyAdminListing(id) {
    var listing = getListing(id);
    if (listing && !isExpiredListing(listing)) {
      listing.status = '在租';
      listing.lifecycleStatus = 'active';
      listing.lastVerifiedAt = '刚刚';
      syncListingRecommendationProfile(listing);
    }
    return activeListings().map(formatAdminListing);
  }

  function reviewOwnerListing(id, action) {
    var listing = getListing(id);
    if (!listing || !requiresListingReview(listing)) return activeListings().map(formatAdminListing);
    var approved = action === 'approve' || action === '已通过';
    listing.reviewStatus = approved ? '已通过' : '已驳回';
    listing.status = approved ? '待确认' : '已驳回';
    listing.reviewedAt = '刚刚';
    listing.reviewNote = approved ? '管理员审核通过，房源已上架' : '管理员审核驳回，房源暂不上架';
    if (approved) applyCommunityMapCoordinate(listing);
    if (approved) {
      syncListingRecommendationProfile(listing);
    } else {
      clearListingRecommendationProfile(listing, 'review_rejected');
    }
    return activeListings().map(formatAdminListing);
  }

  function getListingMaintenanceRule() {
    return Object.assign({
      enabled: false,
      remindDays: [3, 5],
      expireDays: VERIFY_STALE_DAYS,
      status: state.listingMaintenanceRule.enabled ? '已开启' : '已关闭',
      tip: state.listingMaintenanceRule.enabled
        ? '已开启：3 天、5 天提醒上传人电话联系房东；' + VERIFY_STALE_DAYS + ' 天未更新固定自动下架并进入后台废房源池。'
        : '已关闭提醒：' + VERIFY_STALE_DAYS + ' 天未更新仍会固定自动下架并进入后台废房源池。'
    }, state.listingMaintenanceRule);
  }

  function expireListing(listing) {
    if (!listing || isExpiredListing(listing)) return false;
    var freshness = listingFreshness(listing);
    listing.lifecycleStatus = 'expired';
    listing.status = '已下架';
    listing.expiredAt = '刚刚';
    listing.expiredBy = 'system';
    listing.expiredPool = '后台废房源池';
    listing.expiredReason = '超过 ' + VERIFY_STALE_DAYS + ' 天未电话联系房东确认房态';
    listing.expiredStaleDays = freshness.staleDays;
    clearListingRecommendationProfile(listing, 'expired');
    return true;
  }

  function autoExpireOverdueListings() {
    if (state.__autoExpiringListings) return { expiredCount: 0 };
    state.__autoExpiringListings = true;
    var expiredCount = 0;
    try {
      rawActiveListings().forEach(function (listing) {
        if (listingFreshness(listing).staleDays >= VERIFY_STALE_DAYS && expireListing(listing)) {
          expiredCount += 1;
        }
      });
    } finally {
      delete state.__autoExpiringListings;
    }
    return { expiredCount: expiredCount };
  }

  function updateListingMaintenanceRule(payload) {
    state.listingMaintenanceRule.enabled = Boolean(payload && payload.enabled);
    state.listingMaintenanceRule.updatedAt = '刚刚';
    state.listingMaintenanceRule.updatedBy = 'preview-admin';
    var expiredCount = autoExpireOverdueListings().expiredCount;
    var rule = getListingMaintenanceRule();
    rule.expiredCount = expiredCount;
    return rule;
  }

  function getExpiredListings(filter) {
    autoExpireOverdueListings();
    var query = filter || {};
    return state.listings.filter(isExpiredListing).filter(function (listing) {
      if (query.area && listing.area !== query.area) return false;
      if (query.block && listing.block !== query.block) return false;
      if (query.community && String(listing.community || '').indexOf(query.community) === -1) return false;
      return true;
    }).map(formatAdminListing).map(function (row) {
      var listing = getListing(row.id) || {};
      row.expiredAt = listing.expiredAt || '';
      row.expiredReason = listing.expiredReason || ('超过 ' + VERIFY_STALE_DAYS + ' 天未电话联系房东确认房态');
      return row;
    });
  }

  function restoreExpiredListing(id) {
    var listing = getListing(id);
    if (!listing) throw new Error('未找到该房源');
    if (!isExpiredListing(listing)) throw new Error('该房源不在废房源池');
    listing.lifecycleStatus = 'active';
    listing.status = '在租';
    listing.lastVerifiedAt = '刚刚';
    listing.updatedAt = '刚刚';
    listing.restoredAt = '刚刚';
    listing.restoredBy = 'preview-admin';
    delete listing.expiredAt;
    delete listing.expiredBy;
    delete listing.expiredPool;
    delete listing.expiredReason;
    delete listing.expiredStaleDays;
    syncListingRecommendationProfile(listing);
    state.footprints.unshift({
      id: 'F' + Date.now(),
      listingId: id,
      viewerId: state.currentUserId,
      action: '重新上架',
      time: '刚刚',
      sync: '管理员已从后台废房源池重新上架'
    });
    return getEditableListing(id);
  }

  state.listings.forEach(function (listing) {
    syncListingRecommendationProfile(listing);
  });

  return {
    getCurrentUser: function () { return clone(getUser()); },
    loginByPhone: loginByPhone,
    getHomeListings: function () { return publicListings().slice(0, 3).map(formatHomeListing); },
    getListings: getListings,
    matchListings: matchListings,
    getListingDetail: getListingDetail,
    getListingLogs: getListingLogs,
    recordVideoShare: recordVideoShare,
    getFootprintRecords: getFootprintRecords,
    getOwnedListings: getOwnedListings,
    verifyMyListing: verifyMyListing,
    getEditableListing: getEditableListing,
    updateNormalListing: updateNormalListing,
    getProfileState: getProfileState,
    getGroupState: getGroupState,
    getClientReports: getClientReports,
    createClientReport: createClientReport,
    getDealRecords: getDealRecords,
    createDealFromReport: createDealFromReport,
    getMapPins: getMapPins,
    getDashboardSummary: getDashboardSummary,
    getAreaStats: getAreaStats,
    getAdminListings: function () { return activeListings().map(formatAdminListing); },
    getExpiredListings: getExpiredListings,
    restoreExpiredListing: restoreExpiredListing,
    getListingMaintenanceRule: getListingMaintenanceRule,
    updateListingMaintenanceRule: updateListingMaintenanceRule,
    getAdminLogs: getAdminLogs,
    getCommissionRows: getCommissionRows,
    getPointLogs: getPointLogs,
    getRechargeBills: getRechargeBills,
    getGroupUploadRows: getGroupUploadRows,
    getShowingUploadRows: getShowingUploadRows,
    getUsers: function () {
      return state.users.map(function (user) {
        var quota = brokerSensitiveUsage(user.id);
        return Object.assign({}, clone(user), {
          todayOwnerViews: quota.ownerUsed,
          todayNormalViews: quota.normalUsed,
          ownerViewLimit: quota.ownerLimit,
          normalViewLimit: quota.normalLimit
        });
      });
    },
    addSensitiveFootprint: addSensitiveFootprint,
    recordShowing: recordShowing,
    rechargePoints: rechargePoints,
    reviewRechargeBill: reviewRechargeBill,
    uploadGroupListing: uploadGroupListing,
    reviewShowingUpload: reviewShowingUpload,
    unlockGroup: unlockGroup,
    addNormalListing: addNormalListing,
    verifyAdminListing: verifyAdminListing,
    reviewOwnerListing: reviewOwnerListing
  };
});
