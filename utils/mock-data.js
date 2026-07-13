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
  var ELEVATOR_FEATURE = '电梯';
  var COMPANY_SOURCE = '公司房源';
  var V1_COMMISSION_TEXT = '成交总比例按成交总佣金的 30% 计算';
  var COMPANY_COMMISSION_TEXT = '公司房源成交不抽佣，带看中介全佣';
  // 开发者工具预览专用明显假值；生产号码只从服务端环境配置读取。
  var COMPANY_CONTACT_PHONES = ['19900000001', '19900000002', '19900000003'];
  var OWNER_SOURCE = '业主房源';
  var SECOND_LANDLORD_SOURCE = '二房东房源';
  var OWNER_SOURCE_ALIASES = [OWNER_SOURCE, '业主'];
  var SECOND_LANDLORD_SOURCE_ALIASES = [SECOND_LANDLORD_SOURCE, '二房东', '二房東', '普通上传', '合作房源'];
  var OWNER_COMMISSION_RATE = 20;
  var SECOND_LANDLORD_COMMISSION_RATE = 20;
  var PLATFORM_COMMISSION_RATE = 10;
  var BROKER_ROLE = '中介';
  var BROKER_AUTHED = '手机号登录';
  var STAFF_LISTING_AUTO_APPROVAL_NOTE = '内部员工上传，按员工权限自动通过';
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
    { name: 'Loft', pattern: /\bloft\b|挑高复式|复式挑高/i },
    { name: '落地窗', pattern: /落地窗/ },
    { name: '独卫', pattern: /独卫|独立卫|独立厨卫|独厨独卫/ },
    { name: '电梯', pattern: /电梯/ },
    { name: '整租', pattern: /整租|（整）|\(整\)/ },
    { name: '合租', pattern: /合租|单间/ },
    { name: DEPOSIT_FREE_FEATURE, pattern: /免押金|无押金|零押金|押金0|押金为0/ }
  ];
  var LISTING_FEATURE_OPTIONS = [
    '近地铁',
    '电梯',
    '燃气',
    '独卫',
    '朝南',
    'Loft',
    '落地窗',
    '带阳台',
    '带露台（阁楼）',
    '可短租',
    '可月付',
    '干湿分离',
    '采光好',
    '首次出租',
    '民水民电',
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
      { id: 'U007', name: '孙管理', phone: '13800010007', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U008', name: '周管理', phone: '13800010008', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U009', name: '吴管理', phone: '13800010009', role: '管理员', authed: '已实名', isAdmin: true },
      { id: 'U005', name: '刘洋', phone: '13800010005', role: '内部员工', authed: '已实名', isAdmin: false },
      { id: 'U006', name: '赵一', phone: '13800010006', role: '内部员工', authed: '未实名', isAdmin: false }
    ],
    listings: [],
    favorites: [],
    listingMaintenanceRule: {
      enabled: false,
      remindDays: [3, 5],
      expireDays: VERIFY_STALE_DAYS,
      updatedAt: '',
      updatedBy: ''
    },
    commissionConfig: {
      uploaderRates: {
        '二房东房源': 20,
        '业主房源': 20,
        '公司房源': 0
      },
      platformRates: {
        '二房东房源': 10,
        '业主房源': 10,
        '公司房源': 0
      },
      secondLandlordRate: 20,
      ownerRate: 20,
      companyRate: 0,
      secondLandlordPlatformRate: 10,
      ownerPlatformRate: 10,
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

  function normalizeListingRemark(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function listingRemarkContainsContact(value) {
    var text = normalizeListingRemark(value).normalize('NFKC');
    if (!text) return false;
    var compact = text.replace(/[\s\-—_()（）+.,，:：]/g, '');
    if (/1[3-9]\d{9}/.test(compact)) return true;
    return /微信|微\s*信|wei\s*xin|we\s*chat|二维码|https?:\/\/|www\.|(?:^|[^a-z0-9])(?:wx|vx|v信|微号)(?:\s*[:：号]?)/i.test(text);
  }

  function landlordCommissionPercentFrom(form, current) {
    var input = firstOwnValue(form, ['landlordCommissionPercent']);
    var currentValue = firstOwnValue(current, ['landlordCommissionPercent']);
    var raw = input !== undefined ? input : (currentValue !== undefined ? currentValue : 50);
    var text = String(raw === undefined || raw === null ? '' : raw).trim();
    var typeValid = typeof raw === 'number' || typeof raw === 'string';
    var formatValid = typeof raw === 'number' ? Number.isInteger(raw) : /^\d+$/.test(text);
    return typeValid && formatValid ? Number(text) : Number.NaN;
  }

  function validateLandlordCommissionPercent(value) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error('房东佣金占月租比例必须是 0 至 100 的整数');
    }
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

  function prepareSourceFields(form, current, featureState) {
    var companyListing = formCompanyListing(form || {}, current || {});
    var normalizedOwnerType = normalizeOwnerType(firstText((form || {}).ownerType, (form || {}).houseSourceType, (form || {}).landlordType, (current || {}).ownerType, (current || {}).houseSourceType), (current || {}).ownerType || SECOND_LANDLORD_SOURCE);
    var sourceInput = firstText((form || {}).source, (form || {}).sourceType, (form || {}).listingType, (form || {}).inventoryType);
    var nonCompanySourceInput = sourceInput && !/公司房源|company/.test(sourceInput) ? sourceInput : '';
    var currentCompany = isCompanyListing(current || {});
    var ownerType = companyListing ? COMPANY_SOURCE : normalizedOwnerType;
    var noCommission = companyListing;
    // 佣金率一律按房源类型重算，忽略表单/历史传入值，与服务端保持一致。
    var finalRate = noCommission ? 0 : commissionRateByOwnerType(ownerType);
    var features = featuresWithCompanyDefaults(featureState.features, {
      companyListing: companyListing,
      noCommission: noCommission,
      commissionRate: finalRate
    }).filter(function (item) {
      return noCommission || item !== NO_COMMISSION_FEATURE;
    });
    return {
      companyListing: companyListing,
      noCommission: noCommission,
      commissionRate: finalRate,
      ownerType: ownerType,
      source: companyListing ? COMPANY_SOURCE : (nonCompanySourceInput || (currentCompany ? ownerType : firstText((current || {}).source, ownerType))),
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

  function isStaffUser(user) {
    if (!user || user.isAdmin) return false;
    var accountTypeText = String(user.accountType || '').trim();
    var accountType = accountTypeText === 'staff' || accountTypeText === '员工' || accountTypeText === '内部员工' || accountTypeText === '员工账号'
      ? 'staff'
      : (accountTypeText === 'broker' || accountTypeText === '中介' || accountTypeText === '中介账号' ? 'broker' : '');
    var role = String(user.role || '').trim();
    if (accountTypeText) {
      if (accountType !== 'staff') return false;
      return !role || role === '员工' || /^内部员工(?:\s*·.*)?$/.test(role);
    }
    return role === '员工' || /^内部员工(?:\s*·.*)?$/.test(role);
  }

  function shouldAutoApproveStaffListing(user, sourceState) {
    return isStaffUser(user) &&
      !sourceState.companyListing &&
      (sourceState.ownerType === OWNER_SOURCE || sourceState.ownerType === SECOND_LANDLORD_SOURCE);
  }

  function isStaffAutoApprovedListing(listing) {
    return listing && listing.reviewStatus === '已通过' && listing.reviewNote === STAFF_LISTING_AUTO_APPROVAL_NOTE;
  }

  function applyStaffListingAutoApproval(listing, userId) {
    listing.reviewStatus = '已通过';
    if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认';
    listing.reviewedAt = '刚刚';
    listing.reviewerId = userId;
    listing.reviewNote = STAFF_LISTING_AUTO_APPROVAL_NOTE;
  }

  function clearStaffListingAutoApproval(listing) {
    if (!listing || listing.reviewNote !== STAFF_LISTING_AUTO_APPROVAL_NOTE) return;
    delete listing.reviewedAt;
    delete listing.reviewerId;
    delete listing.reviewNote;
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

  function registerUser(form) {
    var payload = form || {};
    var name = String(payload.name || '').trim();
    var phone = String(payload.phone || '').trim();
    var password = String(payload.password || '');
    if (!name || !/^1[3-9]\d{9}$/.test(phone) || password.length < 8) {
      var invalid = new Error('请填写姓名、11 位手机号和至少 8 位密码');
      invalid.statusCode = 400;
      throw invalid;
    }
    var existed = state.users.some(function (item) {
      return String(item.phone || '') === phone && !item.deleted;
    });
    var error = new Error(existed
      ? '该手机号已开通账号，请直接用手机号和密码登录'
      : '已收到您的注册信息，期待和您的合作，请联系寓你住一起管理员开通账号权限');
    error.statusCode = existed ? 409 : 403;
    throw error;
  }

  function logout() {
    state.currentUserId = '';
    return { loggedOut: true, scope: 'all-devices' };
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

  function textInList(value, list) {
    var text = String(value || '').trim();
    return list.indexOf(text) !== -1;
  }

  function ownerTypeFromStructuredValue(value) {
    if (textInList(value, OWNER_SOURCE_ALIASES)) return OWNER_SOURCE;
    if (textInList(value, SECOND_LANDLORD_SOURCE_ALIASES)) return SECOND_LANDLORD_SOURCE;
    return '';
  }

  function normalizeOwnerType(value, fallback) {
    return ownerTypeFromStructuredValue(value) ||
      ownerTypeFromStructuredValue(fallback) ||
      SECOND_LANDLORD_SOURCE;
  }

  function nonCompanyListingSourceType(listing) {
    var data = listing || {};
    var structured = data.ownerType || data.houseSourceType || data.source || '';
    return normalizeOwnerType(structured, SECOND_LANDLORD_SOURCE);
  }

  function listingSourceType(listing) {
    return isCompanyListing(listing || {}) ? COMPANY_SOURCE : nonCompanyListingSourceType(listing || {});
  }

  function boundedRate(value, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(100, Math.max(0, Math.round(number * 100) / 100));
  }

  function firstDefinedValue(primary, fallback) {
    return primary === undefined || primary === null || primary === '' ? fallback : primary;
  }

  function getCommissionConfig() {
    var saved = state.commissionConfig || {};
    var upRates = saved.uploaderRates || {};
    var platRates = saved.platformRates || {};
    var secondLandlordRate = boundedRate(firstDefinedValue(saved.secondLandlordRate, upRates[SECOND_LANDLORD_SOURCE]), SECOND_LANDLORD_COMMISSION_RATE);
    var ownerRate = boundedRate(firstDefinedValue(saved.ownerRate, upRates[OWNER_SOURCE]), OWNER_COMMISSION_RATE);
    var secondLandlordPlatformRate = boundedRate(firstDefinedValue(saved.secondLandlordPlatformRate, platRates[SECOND_LANDLORD_SOURCE]), PLATFORM_COMMISSION_RATE);
    var ownerPlatformRate = boundedRate(firstDefinedValue(saved.ownerPlatformRate, platRates[OWNER_SOURCE]), PLATFORM_COMMISSION_RATE);
    var uploaderRates = {};
    uploaderRates[SECOND_LANDLORD_SOURCE] = secondLandlordRate;
    uploaderRates[OWNER_SOURCE] = ownerRate;
    uploaderRates[COMPANY_SOURCE] = 0;
    var platformRates = {};
    platformRates[SECOND_LANDLORD_SOURCE] = secondLandlordPlatformRate;
    platformRates[OWNER_SOURCE] = ownerPlatformRate;
    platformRates[COMPANY_SOURCE] = 0;
    return {
      uploaderRates: uploaderRates,
      platformRates: platformRates,
      secondLandlordRate: secondLandlordRate,
      ownerRate: ownerRate,
      companyRate: 0,
      secondLandlordPlatformRate: secondLandlordPlatformRate,
      ownerPlatformRate: ownerPlatformRate,
      updatedAt: saved.updatedAt || '',
      updatedBy: saved.updatedBy || ''
    };
  }

  function updateCommissionConfig(payload) {
    function invalidInput(message) {
      var error = new Error(message);
      error.statusCode = 400;
      throw error;
    }
    function isPlainRecord(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      var prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }
    function owns(value, key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    }
    if (!isPlainRecord(payload)) invalidInput('分佣配置必须是对象');
    var data = payload;
    if (owns(data, 'uploaderRates') && !isPlainRecord(data.uploaderRates)) invalidInput('上传人比例配置必须是对象');
    if (owns(data, 'platformRates') && !isPlainRecord(data.platformRates)) invalidInput('平台比例配置必须是对象');
    var upRates = data.uploaderRates || {};
    var platRates = data.platformRates || {};
    function parseSuppliedRate(value) {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        var text = value.trim();
        if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return Number(text);
      }
      return Number.NaN;
    }
    var suppliedRates = [
      ['二房东上传人比例', data.secondLandlordRate, owns(data, 'secondLandlordRate')],
      ['二房东上传人比例', data.secondLandlordUploaderRate, owns(data, 'secondLandlordUploaderRate')],
      ['二房东上传人比例', upRates[SECOND_LANDLORD_SOURCE], owns(upRates, SECOND_LANDLORD_SOURCE)],
      ['业主上传人比例', data.ownerRate, owns(data, 'ownerRate')],
      ['业主上传人比例', data.ownerUploaderRate, owns(data, 'ownerUploaderRate')],
      ['业主上传人比例', upRates[OWNER_SOURCE], owns(upRates, OWNER_SOURCE)],
      ['二房东平台比例', data.secondLandlordPlatformRate, owns(data, 'secondLandlordPlatformRate')],
      ['二房东平台比例', platRates[SECOND_LANDLORD_SOURCE], owns(platRates, SECOND_LANDLORD_SOURCE)],
      ['业主平台比例', data.ownerPlatformRate, owns(data, 'ownerPlatformRate')],
      ['业主平台比例', platRates[OWNER_SOURCE], owns(platRates, OWNER_SOURCE)]
    ];
    var providedRates = suppliedRates.filter(function (entry) { return entry[2]; });
    if (!providedRates.length) invalidInput('至少提供一项受支持的分佣比例');
    providedRates.forEach(function (entry) {
      var value = entry[1];
      var number = parseSuppliedRate(value);
      if (!Number.isFinite(number)) {
        var invalidError = new Error(entry[0] + '必须是有限数字');
        invalidError.statusCode = 400;
        throw invalidError;
      }
      if (number < 0) {
        var error = new Error(entry[0] + '不能小于 0');
        error.statusCode = 400;
        throw error;
      }
    });
    var current = getCommissionConfig();
    var uploaderRates = {};
    var secondLandlordRateInput = firstDefinedValue(
      data.secondLandlordRate,
      firstDefinedValue(data.secondLandlordUploaderRate, upRates[SECOND_LANDLORD_SOURCE])
    );
    var ownerRateInput = firstDefinedValue(
      data.ownerRate,
      firstDefinedValue(data.ownerUploaderRate, upRates[OWNER_SOURCE])
    );
    uploaderRates[SECOND_LANDLORD_SOURCE] = boundedRate(secondLandlordRateInput, current.secondLandlordRate);
    uploaderRates[OWNER_SOURCE] = boundedRate(ownerRateInput, current.ownerRate);
    uploaderRates[COMPANY_SOURCE] = 0;
    var platformRates = {};
    platformRates[SECOND_LANDLORD_SOURCE] = boundedRate(firstDefinedValue(data.secondLandlordPlatformRate, platRates[SECOND_LANDLORD_SOURCE]), current.secondLandlordPlatformRate);
    platformRates[OWNER_SOURCE] = boundedRate(firstDefinedValue(data.ownerPlatformRate, platRates[OWNER_SOURCE]), current.ownerPlatformRate);
    platformRates[COMPANY_SOURCE] = 0;
    if (uploaderRates[SECOND_LANDLORD_SOURCE] + platformRates[SECOND_LANDLORD_SOURCE] > 100) {
      invalidInput('二房东房源：上传人比例 + 平台比例不得超过 100%');
    }
    if (uploaderRates[OWNER_SOURCE] + platformRates[OWNER_SOURCE] > 100) {
      invalidInput('业主房源：上传人比例 + 平台比例不得超过 100%');
    }
    state.commissionConfig = {
      uploaderRates: uploaderRates,
      platformRates: platformRates,
      companyRate: 0,
      updatedAt: '刚刚',
      updatedBy: 'preview-admin'
    };
    state.commissionConfig.secondLandlordRate = uploaderRates[SECOND_LANDLORD_SOURCE];
    state.commissionConfig.ownerRate = uploaderRates[OWNER_SOURCE];
    state.commissionConfig.secondLandlordPlatformRate = platformRates[SECOND_LANDLORD_SOURCE];
    state.commissionConfig.ownerPlatformRate = platformRates[OWNER_SOURCE];
    pushExactFootprint({
      id: 'F' + Date.now(),
      viewerId: 'preview-admin',
      action: '调整分佣配置',
      time: '刚刚',
      sync: '已更新分佣配置'
    });
    return getCommissionConfig();
  }

  function publicCommissionTextForOwnerType(ownerType) {
    var normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE);
    return '成交总比例按成交总佣金的 ' + totalCommissionRateByOwnerType(normalized) + '% 计算';
  }

  function commissionRateByOwnerType(ownerType) {
    var config = getCommissionConfig();
    return normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE) === OWNER_SOURCE
      ? config.ownerRate
      : config.secondLandlordRate;
  }

  function platformRateByOwnerType(ownerType) {
    var config = getCommissionConfig();
    return normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE) === OWNER_SOURCE
      ? config.ownerPlatformRate
      : config.secondLandlordPlatformRate;
  }

  function totalCommissionRateByOwnerType(ownerType) {
    return commissionRateByOwnerType(ownerType) + platformRateByOwnerType(ownerType);
  }

  function commissionRuleForListing(listing, viewerId) {
    var item = listing || {};
    if (isCompanyListing(item) || (item.uploaderId && String(item.uploaderId) === String(viewerId || ''))) {
      return { rate: 0, uploaderRate: 0, platformRate: 0 };
    }
    var uploader = getUser(item.uploaderId) || {};
    var ownerType = listingSourceType(item);
    var uploaderRate = uploader.isAdmin ? 0 : commissionRateByOwnerType(ownerType);
    var platformRate = platformRateByOwnerType(ownerType);
    return { rate: uploaderRate + platformRate, uploaderRate: uploaderRate, platformRate: platformRate };
  }

  function commissionBreakdownForListing(listing, viewerId) {
    var landlordPercent = landlordCommissionPercentFrom({}, listing || {});
    var rule = commissionRuleForListing(listing, viewerId);
    var maintainerPercent = Math.round(landlordPercent * rule.uploaderRate) / 100;
    var platformPercent = Math.round(landlordPercent * rule.platformRate) / 100;
    return {
      landlordPercentOfRent: landlordPercent,
      viewingAgentPercentOfRent: Math.round((landlordPercent - maintainerPercent - platformPercent) * 100) / 100,
      maintainerPercentOfRent: maintainerPercent,
      platformPercentOfRent: platformPercent,
      split: {
        viewingAgentRate: 100 - rule.uploaderRate - rule.platformRate,
        maintainerRate: rule.uploaderRate,
        platformRate: rule.platformRate
      }
    };
  }

  function isOwnerListing(listing) {
    return listingSourceType(listing || {}) === OWNER_SOURCE;
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

  function assertListingVerificationAllowed(listing) {
    if (!isPendingOwnerReview(listing)) return;
    var error = new Error('该房源仍在等待管理员审核，不能通过房态核验直接上架');
    error.statusCode = 409;
    throw error;
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

  function footprintActionText(record) {
    var item = record || {};
    if (item.action) return item.action;
    if (item.actionType === 'phone_call_opened') return '电话查看（已打开系统拨号页）';
    if (item.actionType === 'sensitive_view') return '查看地址和电话';
    if (item.actionType === 'showing_verified') return '记录带看';
    if (item.actionType === 'video_shared') return '转发房间视频给租客';
    if (item.actionType === 'listing_restored') return '重新上架';
    if (item.actionType === 'commission_config_updated') return '调整分佣配置';
    return String(item.actionType || '');
  }

  function footprintOccurredAt(record) {
    var item = record || {};
    return item.time || item.occurredAt || '';
  }

  function footprintTimeMs(record) {
    var item = record || {};
    var legacyTime = String(item.time || '').trim();
    var raw = String(item.occurredAt || (legacyTime && legacyTime !== '刚刚' ? legacyTime : item.dateKey) || '').trim();
    if (!raw) return null;
    var parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function footprintWithinDays(record, days, now) {
    var time = footprintTimeMs(record);
    if (time === null) return days >= 90;
    var current = now || Date.now();
    return time <= current && current - time <= days * 24 * 60 * 60 * 1000;
  }

  function footprintDateKey(record) {
    var item = record || {};
    if (item.dateKey) return String(item.dateKey);
    if (item.time === '刚刚') return todayKey();
    var time = footprintTimeMs(item);
    return time === null ? '' : new Date(time).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  }

  function isSensitiveFootprint(record) {
    var item = record || {};
    return item.actionType === 'sensitive_view' || Boolean(item.quotaCategory) || /查看地址和电话|查看敏感信息/.test(String(item.action || ''));
  }

  function isPhoneFootprint(record) {
    var item = record || {};
    return item.actionType === 'phone_call_opened' || /电话查看/.test(String(item.action || ''));
  }

  function pruneExpiredFootprints() {
    state.footprints = (state.footprints || []).filter(function (item) {
      return footprintWithinDays(item, 90);
    });
  }

  function exactActionType(record) {
    var item = record || {};
    if (item.actionType) return item.actionType;
    if (/下架|已出租|不租了/.test(String(item.action || ''))) return 'listing_expired';
    var map = {
      '查看地址和电话': 'sensitive_view',
      '记录带看': 'showing_verified',
      '转发房间视频给租客': 'video_shared',
      '重新上架': 'listing_restored',
      '调整分佣配置': 'commission_config_updated'
    };
    return map[item.action] || 'listing_activity';
  }

  function pushExactFootprint(record) {
    pruneExpiredFootprints();
    var item = record || {};
    var footprintId = String(item.id || ('F' + Date.now()));
    var stored = {
      id: footprintId,
      viewerId: String(item.viewerId || 'system'),
      listingId: String(item.listingId || ''),
      actionType: exactActionType(item),
      occurredAt: new Date().toISOString(),
      idempotencyKey: String(item.idempotencyKey || footprintId)
    };
    state.footprints = state.footprints || [];
    state.footprints.unshift(stored);
    return stored;
  }

  function assertClientFootprintRateLimit(viewerId, actionType) {
    var now = Date.now();
    var recentCount = (state.footprints || []).filter(function (item) {
      var occurredAtMs = footprintTimeMs(item);
      return String(item.viewerId || '') === String(viewerId || '') &&
        String(item.actionType || '') === String(actionType || '') &&
        occurredAtMs !== null && occurredAtMs <= now && now - occurredAtMs < 60 * 1000;
    }).length;
    if (recentCount < 30) return;
    var error = new Error('操作过于频繁，请稍后再试');
    error.statusCode = 429;
    error.data = { reason: 'FOOTPRINT_RATE_LIMITED', retryAfterSeconds: 60 };
    throw error;
  }

  function withListingNames(record) {
    var listing = getListing(record.listingId) || {};
    var viewer = getUser(record.viewerId) || {};
    var uploader = getUser(listing.uploaderId) || {};
    var isMine = record.viewerId === state.currentUserId;
    return {
      id: record.id,
      title: listing.title || '未知房源',
      status: footprintActionText(record),
      customer: '查看人：' + (viewer.name || '未知') + ' · ' + (viewer.authed || '未实名'),
      time: footprintOccurredAt(record),
      price: listing.rent ? '¥' + listing.rent + '/月' : '',
      meta: '上传人：' + (uploader.name || '未知') + (record.sync ? ' · ' + record.sync : ''),
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

  function companyListingFlag(value) {
    if (truthyFlag(value)) return true;
    return ['y', '公司', COMPANY_SOURCE].indexOf(String(value || '').trim().toLowerCase()) !== -1;
  }

  function isCompanyListing(listing) {
    var data = listing || {};
    var sourceText = [data.source, data.sourceType, data.listingType, data.inventoryType].map(function (item) {
      return String(item || '');
    }).join(' ');
    return Boolean(companyListingFlag(data.companyListing) || companyListingFlag(data.isCompanyListing) || truthyFlag(data.companyOwned) || /公司房源|company/.test(sourceText));
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
    var companyListing = isCompanyListing(data);
    var features = featuresWithNoCommission(value, data).filter(function (item) {
      return item !== NO_FEATURE;
    });
    if (companyListing && features.indexOf(DEPOSIT_FREE_FEATURE) === -1) {
      features.push(DEPOSIT_FREE_FEATURE);
    }
    if (companyListing && features.indexOf(ELEVATOR_FEATURE) === -1) {
      features.push(ELEVATOR_FEATURE);
    }
    return features.length ? features : [NO_FEATURE];
  }

  function listingSourceFields(listing) {
    var data = listing || {};
    var ownerType = listingSourceType(data);
    var companyListing = ownerType === COMPANY_SOURCE;
    var noCommission = companyListing;
    var reviewStatus = ownerReviewStatus(Object.assign({}, data, { ownerType: ownerType }));
    var sourceLabel = companyListing ? COMPANY_SOURCE : ownerType;
    return {
      companyListing: companyListing,
      isCompanyListing: companyListing,
      noCommission: noCommission,
      ownerType: ownerType,
      houseSourceType: ownerType,
      isOwnerListing: !companyListing && ownerType === OWNER_SOURCE,
      reviewStatus: reviewStatus,
      requiresManualReview: truthyFlag(data.requiresManualReview),
      manualReviewReason: data.manualReviewReason || '',
      communityMatched: data.communityMatched !== undefined ? truthyFlag(data.communityMatched) : data.communityMatchStatus !== '未匹配',
      communityMatchStatus: data.communityMatchStatus || (data.communityMatched === false ? '未匹配' : '已匹配'),
      sourceLabel: sourceLabel,
      commissionText: companyListing ? COMPANY_COMMISSION_TEXT : publicCommissionTextForOwnerType(ownerType),
      commissionBadge: companyListing ? '带看全佣' : ('分佣 ' + totalCommissionRateByOwnerType(ownerType) + '%')
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
      todaySensitiveViews: state.footprints.filter(function (item) { return isSensitiveFootprint(item) && footprintDateKey(item) === todayKey(); }).length,
      pendingShowingUploadCount: (state.showingUploads || []).filter(function (item) { return item.status === '待审核'; }).length
    };
  }

  function formatHomeListing(listing) {
    var uploader = getUser(listing.uploaderId) || {};
    var location = listingLocationFields(listing);
    var display = listingDisplayFields(listing);
    var companyListing = display.companyListing;
    var hasVideo = hasListingVideo(listing);
    var mediaText = hasVideo ? '仅视频' : (companyListing ? '公司房源表' : '待补视频');
    var publicTitle = listing.shortTitle || location.community || listing.community || ((location.area || '房源') + (listing.layout ? ' · ' + listing.layout : ''));
    return Object.assign({
      id: listing.id,
      title: publicTitle,
      meta: (location.locationSummary || location.area) + ' · ' + listing.layout + ' · ' + mediaText,
      sub: display.sourceLabel + ' · ' + display.commissionText + ' · 上传人 ' + (uploader.name || '平台'),
      price: '¥' + listing.rent + '/月',
      tag: companyListing ? COMPANY_SOURCE : (commissionRateByOwnerType(display.ownerType) + '%'),
      videoUrl: listing.videoUrl || '',
      hasVideo: hasVideo,
      coverUrl: '',
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
    if ([COMPANY_SOURCE, OWNER_SOURCE, SECOND_LANDLORD_SOURCE].indexOf(category) !== -1) {
      return listingSourceType(listing) === category;
    }
    var display = listingDisplayFields(listing);
    var text = String((listing.type || '') + (listing.layout || '') + (listing.source || '') + (display.ownerType || '') + (display.sourceLabel || ''));
    return text.indexOf(category) !== -1;
  }

  function getListings(filter) {
    var query = filter || {};
    return publicListings().filter(function (listing) {
      var areaText = String((listing.city || '') + (listing.district || '') + (listing.area || '') + (listing.block || '') + (listing.community || '') + (listing.building || '') + (listing.unit || '') + (listing.roomNumber || '') + (listing.address || ''));
      if (truthyFlag(query.companyOnly) && listingSourceType(listing) !== COMPANY_SOURCE) return false;
      if (!matchesCategory(listing, query.category)) return false;
      if (query.district && String((listing.district || '') + (listing.area || '')).indexOf(query.district) === -1) return false;
      if (query.area && areaText.indexOf(query.area) === -1) return false;
      if (query.block && areaText.indexOf(query.block) === -1) return false;
      if (query.community && String(listing.community || '').indexOf(query.community) === -1) return false;
      if (query.layout && String(listing.layout || '').indexOf(query.layout) === -1) return false;
      if (query.rentMode && (listing.rentMode || listing.type) !== query.rentMode) return false;
      if (query.rentMin && Number(listing.rent || 0) < Number(query.rentMin)) return false;
      if (query.rentMax && Number(listing.rent || 0) > Number(query.rentMax)) return false;
      var requestedFeatures = parseFeatureInput(query.features || query.feature);
      if (requestedFeatures.length) {
        var featureSet = listingMatchFeatureSet(listing);
        if (!requestedFeatures.every(function (feature) { return featureSet.has(feature); })) return false;
      }
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

  function favoriteRecordsForCurrentUser() {
    return (state.favorites || []).filter(function (item) {
      return item && item.userId === state.currentUserId;
    });
  }

  function getFavoriteIds() {
    var seen = {};
    return favoriteRecordsForCurrentUser()
      .slice()
      .sort(function (left, right) {
        return Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '');
      })
      .map(function (item) { return String(item.listingId || ''); })
      .filter(function (listingId) {
        if (!listingId || seen[listingId]) return false;
        seen[listingId] = true;
        return true;
      });
  }

  function isFavoriteListingAvailable(listing) {
    if (!listing || isExpiredListing(listing) || isPendingOwnerReview(listing)) return false;
    if (listing.lifecycleStatus === 'sold' || /成交|签单/.test(String(listing.status || ''))) return false;
    return isCompanyListing(listing) || hasListingVideo(listing);
  }

  function setFavorite(listingId, desired) {
    var id = String(listingId || '').trim();
    if (!id) throw new Error('缺少房源编号');
    state.favorites = state.favorites || [];
    var existing = state.favorites.find(function (item) {
      return item.userId === state.currentUserId && item.listingId === id;
    });
    if (!desired) {
      state.favorites = state.favorites.filter(function (item) {
        return !(item.userId === state.currentUserId && item.listingId === id);
      });
      return { listingId: id, favorited: false, isFavorited: false };
    }
    if (existing) {
      return {
        id: existing.id,
        listingId: id,
        favorited: true,
        isFavorited: true,
        favoritedAt: existing.createdAt || ''
      };
    }
    var listing = getListing(id);
    if (!isFavoriteListingAvailable(listing)) {
      var error = new Error(listing ? '该房源暂不可收藏' : '房源不存在，无法收藏');
      error.statusCode = listing ? 410 : 404;
      throw error;
    }
    var record = {
      id: 'FV' + Date.now() + Math.floor(Math.random() * 1000),
      userId: state.currentUserId,
      listingId: id,
      createdAt: new Date().toISOString()
    };
    state.favorites.unshift(record);
    return {
      id: record.id,
      listingId: id,
      favorited: true,
      isFavorited: true,
      favoritedAt: record.createdAt
    };
  }

  function mockFavoriteLayoutMatches(listing, value) {
    var filter = String(value || '').trim();
    if (!filter || filter === '不限') return true;
    var text = [listing.layout, listing.room, listing.type, listing.rentMode].join(' ');
    var matched = text.match(/([一二两三四五六七八九]|\d+)\s*室/);
    var map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    var count = matched ? (map[matched[1]] || Number(matched[1]) || 0) : 0;
    if (filter === '一室') return count === 1;
    if (filter === '两室' || filter === '二室') return count === 2;
    if (filter === '三室') return count === 3;
    if (filter === '三室以上') return count >= 3;
    return String(listing.layout || '').indexOf(filter) !== -1;
  }

  function favoriteSafeRow(listing, relationship) {
    if (!listing) {
      return {
        id: relationship.listingId,
        title: '已删除房源',
        meta: '房源信息已移除',
        sub: '暂不可用',
        price: '',
        rent: 0,
        layout: '',
        rentMode: '',
        type: '',
        district: '',
        area: '',
        block: '',
        community: '',
        features: [],
        source: '',
        sourceLabel: '',
        status: '暂不可用',
        isAvailable: false,
        unavailableReason: '房源不存在或已删除',
        isFavorited: true,
        favoritedAt: relationship.createdAt || ''
      };
    }
    var location = listingLocationFields(listing);
    var display = listingDisplayFields(listing);
    var available = isFavoriteListingAvailable(listing);
    var source = listing.source || display.ownerType || '';
    var rent = Number(listing.rent || 0);
    return {
      id: listing.id,
      title: listing.shortTitle || location.community || '房源',
      meta: [location.locationSummary || location.area, listing.layout, display.sourceLabel || source].filter(Boolean).join(' · '),
      sub: available ? [listing.layout, display.sourceLabel || source, listing.status].filter(Boolean).join(' · ') : '暂不可用',
      price: rent ? '¥' + rent + '/月' : '',
      rent: rent,
      layout: listing.layout || '',
      rentMode: listing.rentMode || listing.type || '',
      type: listing.rentMode || listing.type || '',
      district: location.district,
      area: location.area,
      block: location.block,
      community: location.community,
      features: display.features || [],
      source: source,
      sourceLabel: display.sourceLabel || source,
      status: listing.status || '',
      companyListing: isCompanyListing(listing),
      hasVideo: available && hasListingVideo(listing),
      coverUrl: '',
      isAvailable: available,
      unavailableReason: available ? '' : '该房源已下架、成交或正在审核',
      isFavorited: true,
      favoritedAt: relationship.createdAt || ''
    };
  }

  function getFavorites(filter) {
    var query = filter || {};
    var requestedFeatures = parseFeatureInput(query.features || query.feature);
    var seen = {};
    return favoriteRecordsForCurrentUser()
      .slice()
      .sort(function (left, right) {
        return Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '');
      })
      .filter(function (relationship) {
        if (!relationship.listingId || seen[relationship.listingId]) return false;
        seen[relationship.listingId] = true;
        return true;
      })
      .map(function (relationship) {
        return { relationship: relationship, listing: getListing(relationship.listingId) };
      })
      .filter(function (entry) {
        var listing = entry.listing;
        var available = isFavoriteListingAvailable(listing);
        if (query.availability === 'available' && !available) return false;
        if (query.availability === 'unavailable' && available) return false;
        if (!listing) return !query.category && !query.district && !query.area && !query.block && !query.community && !query.layout && !query.rentMode && !query.rentMin && !query.rentMax && !requestedFeatures.length;
        var district = String(query.district || query.area || '');
        if (query.category && !matchesCategory(listing, query.category)) return false;
        if (district && [listing.district, listing.area].join('').indexOf(district) === -1) return false;
        if (query.block && String(listing.block || '').indexOf(query.block) === -1) return false;
        if (query.community && String(listing.community || '').indexOf(query.community) === -1) return false;
        if (!mockFavoriteLayoutMatches(listing, query.layout)) return false;
        if (query.rentMode && (listing.rentMode || listing.type) !== query.rentMode) return false;
        if (query.rentMin && Number(listing.rent || 0) < Number(query.rentMin)) return false;
        if (query.rentMax && Number(listing.rent || 0) > Number(query.rentMax)) return false;
        if (requestedFeatures.length) {
          var featureSet = listingMatchFeatureSet(listing);
          if (!requestedFeatures.every(function (feature) { return featureSet.has(feature); })) return false;
        }
        return true;
      })
      .map(function (entry) { return favoriteSafeRow(entry.listing, entry.relationship); });
  }

  function matchListings(condition) {
    var budget = Number(condition.budget || 0);
    var area = (condition.area || '').trim();
    var layout = (condition.layout || '').trim();
    var requestedFeatures = parseFeatureInput(condition.features).filter(function (item) {
      return item !== NO_FEATURE;
    });
    var hasCondition = budget || area || layout || requestedFeatures.length;
    var availableListings = publicListings().filter(function (listing) {
      return !truthyFlag(condition.companyOnly) || listingSourceType(listing) === COMPANY_SOURCE;
    });
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
      remark: listingRemarkContainsContact(listing.remark) ? '' : normalizeListingRemark(listing.remark),
      landlordCommissionPercent: landlordCommissionPercentFrom({}, listing),
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

  var VIEWING_METHOD_OPTIONS = ['钥匙', '密码', '联系房东'];

  // 看房方式展示口径（与 server/src/domain.js 的 listingViewingMethodFields 同步）：
  // 公司房源跟飞书表走——密码列是真密码才算密码看房，「几号空出」腾房备注或空 → 联系房东（打公司看房电话）；
  // 非公司房源电话优先。只含方式名，不含密码/钥匙位置等敏感值本身。
  function listingViewingMethodFields(listing) {
    var item = listing || {};
    var method = firstText(item.viewingMethod, item.showingMethod);
    var rawPassword = firstText(item.viewingPassword, item.showingPassword, item.password);
    var hasPassword = Boolean(rawPassword) && !/空出/.test(rawPassword);
    var hasPhone = Boolean(firstText(item.landlordPhone, item.contact));
    if (!method) {
      if (isCompanyListing(item)) {
        method = hasPassword ? '密码' : '联系房东';
      } else {
        method = hasPhone ? '联系房东' : (hasPassword ? '密码' : '');
      }
    }
    return {
      viewingMethod: method,
      viewingMethodText: method || '联系房东'
    };
  }

  function listingUnavailableReason(listing) {
    var item = listing || {};
    if (!item.id) return { reason: 'not-found', reasonText: '房源不存在' };
    if (isSoldListing(item)) {
      return { reason: 'down', reasonText: '该房源已成交或已下架，请返回重新找房。' };
    }
    if (isExpiredListing(item)) {
      var expiredReason = String(item.expiredReason || '');
      var expiredByCycle = item.expiredStaleDays !== undefined || /超过\s*\d+\s*天|未电话联系|房态/.test(expiredReason);
      return expiredByCycle
        ? { reason: 'expired', reasonText: '该房源已超过核验周期或已失效，请返回重新找房。' }
        : { reason: 'down', reasonText: '该房源已下架或已更新，请返回重新找房。' };
    }
    if (isPendingOwnerReview(item)) {
      return { reason: 'pending', reasonText: '该房源正在审核，暂不能查看详情，请返回重新找房。' };
    }
    if (!isCompanyListing(item) && !hasListingVideo(item)) {
      return { reason: 'pending', reasonText: '该房源视频素材待补充，暂不能查看详情，请返回重新找房。' };
    }
    return { reason: '', reasonText: '' };
  }

  function unavailableListingDetail(listing, listingId) {
    var unavailable = listingUnavailableReason(listing);
    return {
      id: listing ? listing.id : listingId,
      unavailable: true,
      reason: unavailable.reason,
      reasonText: unavailable.reasonText,
      status: listing ? (listing.status || '') : '',
      updatedAt: listing ? (listing.updatedAt || '') : '',
      syncedAt: listing ? (listing.syncedAt || '') : '',
      feishuLastSyncAction: listing ? (listing.feishuLastSyncAction || '') : '',
      feishuLastSyncAt: listing ? (listing.feishuLastSyncAt || listing.syncedAt || '') : ''
    };
  }

  function getListingDetail(id, options) {
    autoExpireOverdueListings();
    var listing = getListing(id);
    if (!listing) {
      var notFoundError = new Error('房源不存在');
      notFoundError.statusCode = 404;
      throw notFoundError;
    }
    var settings = options || {};
    if (settings.companyOnly && !isCompanyListing(listing)) {
      var accessError = new Error('游客仅可查看公司房源，请登录后查看合作房源');
      accessError.statusCode = 401;
      throw accessError;
    }
    if (!isMockFrontendEffectiveListing(listing)) return unavailableListingDetail(listing, id);
    var location = listingLocationFields(listing);
    var companyListing = isCompanyListing(listing);
    var companyContactText = COMPANY_CONTACT_PHONES[0] || '';
    var detail = Object.assign({
      id: listing.id,
      title: listing.title,
      ownListing: Boolean(listing.uploaderId && String(listing.uploaderId) === String(state.currentUserId)),
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
      address: companyListing ? (listing.address || [location.locationSummary, location.roomAddress].filter(Boolean).join('')) : '确认留痕后可查看',
      landlordPhone: companyListing ? companyContactText : '确认留痕后可查看',
      contact: companyListing ? companyContactText : '',
      companyContactPhones: companyListing ? COMPANY_CONTACT_PHONES.slice() : [],
      companyContactPhoneText: companyListing ? companyContactText : '',
      sensitiveLocked: !companyListing,
      remark: listingRemarkContainsContact(listing.remark) ? '' : normalizeListingRemark(listing.remark),
      landlordCommissionPercent: landlordCommissionPercentFrom({}, listing),
      commissionBreakdown: commissionBreakdownForListing(listing, state.currentUserId),
      videoLabel: listing.videoLabel,
      videoUrl: listing.videoUrl || '',
      videoKey: listing.videoKey || '',
      type: listing.type || listing.rentMode || '',
      rentMode: listing.rentMode || listing.type || '',
      room: listing.room || '',
      hall: listing.hall || '',
      bath: listing.bath || '',
      status: listing.status
    }, listingViewingMethodFields(listing), companyListing ? {
      viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
      viewingKeyLocation: firstText(listing.viewingKeyLocation, listing.keyLocation)
    } : {}, listingDisplayFields(listing));
    delete detail.uploader;
    delete detail.commissionRate;
    delete detail.commissionText;
    delete detail.commissionBadge;
    detail.nearby = getNearbyListings(id, { companyOnly: settings.companyOnly === true });
    return detail;
  }

  function getListingLogs(listingId) {
    return state.footprints.filter(function (item) {
      return item.listingId === listingId && footprintWithinDays(item, 7);
    }).map(function (item) {
      var user = getUser(item.viewerId) || {};
      return {
        user: user.name || '未知',
        action: footprintActionText(item),
        needId: item.needId || '',
        purpose: item.purpose || '',
        time: footprintOccurredAt(item)
      };
    });
  }

  function getFootprintRecords() {
    return state.footprints.filter(function (record) {
      var listing = getListing(record.listingId) || {};
      var related = record.viewerId === state.currentUserId || listing.uploaderId === state.currentUserId;
      return related && (isSensitiveFootprint(record) || isPhoneFootprint(record)) && footprintWithinDays(record, 7);
    }).map(withListingNames);
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
      }, listingDisplayFields(listing), {
        // 上传人自查自己房源直接展示地址/房东电话（免留痕）+ 电话确认拨号用。放最后确保不被脱敏值覆盖。
        address: listing.address || '',
        landlordPhone: listing.landlordPhone || ''
      });
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
      favoriteCount: getFavoriteIds().length,
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
        { title: '敏感信息查看', value: getFootprintRecords().filter(function (item) { return item.direction === '我的房源被查看'; }).length + ' 条最近 7 天地址或电话查看足迹' },
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
    return !isExpiredListing(listing) &&
      !isSoldListing(listing) &&
      (isCompanyListing(listing) || hasListingVideo(listing)) &&
      !isPendingOwnerReview(listing);
  }

  function nearbyReliableCoordinate(listing) {
    var data = listing || {};
    var communityCoordinate = coordinateByCommunity(data.community);
    if (communityCoordinate) {
      return {
        latitude: Number(communityCoordinate.latitude),
        longitude: Number(communityCoordinate.longitude)
      };
    }
    var latitude = Number(data.mapLatitude || data.latitude);
    var longitude = Number(data.mapLongitude || data.longitude);
    var source = String(data.coordinateSource || '');
    var level = String(data.coordinateLevel || data.coordinateAccuracy || '');
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    if (isDefaultMapCoordinate(latitude, longitude)) return null;
    if (data.coordinateVerified !== true || level !== 'verified') return null;
    if (/block-center|tencent-geocode|qq-map-geocode|geocoder|approx|default|pending|legacy|estimated/i.test(source)) return null;
    if (!/admin-verified-coordinate|community-coordinate|manual-confirmed|lianjia|amap/i.test(source)) return null;
    return { latitude: latitude, longitude: longitude };
  }

  function nearbyDistanceKm(from, to) {
    var radians = function (value) { return value * Math.PI / 180; };
    var latitudeDelta = radians(to.latitude - from.latitude);
    var longitudeDelta = radians(to.longitude - from.longitude);
    var leftLatitude = radians(from.latitude);
    var rightLatitude = radians(to.latitude);
    var haversine = Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
      Math.cos(leftLatitude) * Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2);
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
  }

  function nearbyDistanceText(distanceKm) {
    var meters = Math.max(0, Math.round(Number(distanceKm) * 1000));
    return meters < 1000 ? (meters + '米') : (Number(distanceKm).toFixed(1) + '公里');
  }

  function mockNearbyCard(listing, distanceKm) {
    var location = listingLocationFields(listing);
    var display = listingDisplayFields(listing);
    var sourceLabel = display.sourceLabel || listing.source || listing.ownerType || '';
    var rent = Number(listing.rent || 0);
    var rentMode = listing.rentMode || listing.type || '';
    return {
      id: listing.id,
      title: listing.shortTitle || location.community || '房源',
      meta: [location.community || location.area, listing.layout, sourceLabel].filter(Boolean).join(' · '),
      coverUrl: '',
      hasVideo: hasListingVideo(listing),
      distanceKm: Number(Number(distanceKm).toFixed(3)),
      distanceText: nearbyDistanceText(distanceKm),
      source: sourceLabel,
      sourceLabel: sourceLabel,
      companyListing: isCompanyListing(listing),
      type: rentMode,
      rentMode: rentMode,
      layout: listing.layout || '',
      features: (display.features || []).slice(),
      featureText: display.featureText || '',
      rent: rent,
      price: rent ? ('¥' + rent + '/月') : '',
      community: location.community || ''
    };
  }

  function emptyNearbyResult() {
    return { radiusKm: 3, total: 0, hasMore: false, listings: [] };
  }

  function getNearbyListings(anchorListingId, options) {
    autoExpireOverdueListings();
    var settings = options || {};
    var anchorId = String(anchorListingId || '').trim();
    var anchor = getListing(anchorId);
    if (!anchor) return emptyNearbyResult();
    if (settings.companyOnly && !isCompanyListing(anchor)) {
      var accessError = new Error('游客仅可查看公司房源，请登录后查看合作房源');
      accessError.statusCode = 401;
      throw accessError;
    }
    if (!isMockFrontendEffectiveListing(anchor)) return emptyNearbyResult();
    var anchorCoordinate = nearbyReliableCoordinate(anchor);
    if (!anchorCoordinate) return emptyNearbyResult();
    var candidates = state.listings
      .filter(function (listing) {
        return listing.id !== anchorId && isMockFrontendEffectiveListing(listing) &&
          (!settings.companyOnly || isCompanyListing(listing));
      })
      .map(function (listing) {
        var coordinate = nearbyReliableCoordinate(listing);
        if (!coordinate) return null;
        var distanceKm = nearbyDistanceKm(anchorCoordinate, coordinate);
        if (!isFinite(distanceKm) || distanceKm > 3) return null;
        return { listing: listing, distanceKm: distanceKm };
      })
      .filter(Boolean)
      .sort(function (left, right) {
        if (left.distanceKm !== right.distanceKm) return left.distanceKm - right.distanceKm;
        return String(left.listing.id || '').localeCompare(String(right.listing.id || ''), 'zh-CN');
      });
    var total = candidates.length;
    var selected = settings.all === true ? candidates : candidates.slice(0, 6);
    var listings = selected.map(function (item) {
      return mockNearbyCard(item.listing, item.distanceKm);
    });
    return {
      radiusKm: 3,
      total: total,
      hasMore: settings.all === true ? false : total > listings.length,
      listings: listings
    };
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

  function getMapPins(filter) {
    var query = filter || {};
    return publicListings().filter(function (listing) {
      if (truthyFlag(query.companyOnly) && listingSourceType(listing) !== COMPANY_SOURCE) return false;
      if (query.sourceType && query.sourceType !== '全部' && !matchesCategory(listing, query.sourceType)) return false;
      return true;
    }).map(function (listing) {
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
    return state.footprints.filter(function (item) {
      return footprintWithinDays(item, 90);
    }).map(function (item) {
      var listing = getListing(item.listingId) || {};
      var viewer = getUser(item.viewerId) || {};
      var uploader = getUser(listing.uploaderId) || {};
      return {
        id: item.id,
        viewer: viewer.name,
        listing: listing.shortTitle,
        action: footprintActionText(item),
        uploader: uploader.name,
        sync: item.sync || '',
        time: footprintOccurredAt(item)
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

  function commissionFenToYuanText(value) {
    return (Number(value || 0) / 100).toFixed(2);
  }

  function getCommissionRecords() {
    return state.commissionRecords.filter(function (item) {
      return item.uploaderId === state.currentUserId || item.dealUserId === state.currentUserId;
    }).map(function (item) {
      var listing = getListing(item.listingId) || {};
      var location = listingLocationFields(listing);
      var uploader = getUser(item.uploaderId) || {};
      var dealer = getUser(item.dealUserId) || {};
      var fallbackRate = SECOND_LANDLORD_COMMISSION_RATE + PLATFORM_COMMISSION_RATE;
      return {
        id: item.id,
        listingId: item.listingId,
        title: listing.title || listing.shortTitle || location.community || '未知房源',
        role: item.uploaderId === state.currentUserId ? '我是上传人' : '我是成交人',
        uploader: uploader.name || '未知',
        dealer: dealer.name || '未知',
        rate: (item.rate || fallbackRate) + '%',
        uploaderRate: item.uploaderRate === undefined ? (item.rate || SECOND_LANDLORD_COMMISSION_RATE) : item.uploaderRate,
        platformRate: item.platformRate === undefined ? 0 : item.platformRate,
        dealMonthlyRentFen: item.dealMonthlyRentFen || 0,
        landlordCommissionFen: item.landlordCommissionFen || 0,
        uploaderCommissionFen: item.uploaderCommissionFen || 0,
        platformCommissionFen: item.platformCommissionFen || 0,
        dealMonthlyRent: item.dealMonthlyRentFen ? commissionFenToYuanText(item.dealMonthlyRentFen) : '',
        landlordCommission: item.landlordCommissionFen ? commissionFenToYuanText(item.landlordCommissionFen) : '',
        uploaderCommission: commissionFenToYuanText(item.uploaderCommissionFen || 0),
        platformCommission: commissionFenToYuanText(item.platformCommissionFen || 0),
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
      if (!isSensitiveFootprint(record)) return;
      if (footprintDateKey(record) !== targetDate) return;
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

  function assertSensitiveViewerEligible() {
    var viewer = getUser() || {};
    if (!isBrokerUser(viewer) && viewer.authed !== '已实名') {
      var authError = new Error('查看地址和房东联系方式前需要先完成实名认证');
      authError.statusCode = 403;
      throw authError;
    }
    return viewer;
  }

  function assertSensitiveViewQuotaAllowed(listing) {
    var category = sensitiveQuotaCategory(listing || {}, state.currentUserId);
    var date = todayKey();
    var alreadyViewed = (state.footprints || []).some(function (record) {
      if (record.viewerId !== state.currentUserId || record.listingId !== (listing || {}).id) return false;
      if (!isSensitiveFootprint(record)) return false;
      return footprintDateKey(record) === date;
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

  function assertSensitiveViewAllowed(listing) {
    assertSensitiveViewerEligible();
    return assertSensitiveViewQuotaAllowed(listing);
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
    var needId = String(data.needId || data.rentalNeedId || data.clientNeedId || '').trim();
    if (needId) {
      var need = (state.rentalNeeds || []).find(function (item) {
        return item && item.id === needId;
      });
      if (!need || need.brokerId !== state.currentUserId) {
        throw new Error('只能使用自己的需求单');
      }
    }
    var showing = {
      id: 'SH' + Date.now(),
      listingId: listingId,
      userId: state.currentUserId,
      needId: needId,
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

  function reportDealPausedError() {
    var error = new Error('客户报备与签单功能已暂停');
    error.statusCode = 410;
    error.data = { reason: 'REPORT_DEAL_PAUSED' };
    return error;
  }

  function createClientReport(listingId, payload) {
    throw reportDealPausedError();
    /* istanbul ignore next -- 历史恢复实现保留，默认暂停时不可达。 */
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
    throw reportDealPausedError();
    /* istanbul ignore next -- 历史恢复实现保留，默认暂停时不可达。 */
    var data = payload || {};
    var report = (state.clientReports || []).find(function (item) { return item.id === reportId; });
    if (!report) throw new Error('未找到报备记录');
    if (report.brokerId !== state.currentUserId) throw new Error('只能从自己的报备记录发起签单');
    if (report.dealId) throw new Error('该报备已发起签单');
    var listing = getListing(report.listingId);
    if (!listing) throw new Error('未找到该房源');
    var monthlyRentFen = yuanToFen(data.monthlyRent || data.dealMonthlyRent);
    if (!monthlyRentFen) throw new Error('成交月租必填');
    var landlordCommissionPercent = landlordCommissionPercentFrom({}, listing);
    var landlordCommissionFen = Math.round(monthlyRentFen * landlordCommissionPercent / 100);
    var commissionRule = commissionRuleForListing(listing, state.currentUserId);
    var commissionBreakdown = commissionBreakdownForListing(listing, state.currentUserId);
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
      landlordCommissionPercent: landlordCommissionPercent,
      commissionRule: commissionRule,
      commissionBreakdown: commissionBreakdown,
      dealSnapshot: {
        listingId: report.listingId,
        reportId: reportId,
        brokerId: state.currentUserId,
        uploaderId: listing.uploaderId,
        landlordCommissionPercent: landlordCommissionPercent,
        landlordCommissionFen: landlordCommissionFen,
        commissionRule: commissionRule,
        commissionBreakdown: commissionBreakdown
      },
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
    var data = typeof payload === 'object' && payload ? payload : {};
    var listing = getListing(listingId);
    if (isExpiredListing(listing)) {
      throw new Error('该房源已下架，已进入后台废房源池');
    }
    if (isPendingOwnerReview(listing)) {
      throw new Error('该房源正在等待管理员审核，审核通过后才会上架');
    }
    // 上传人自查自己上传的房源：直接返回地址/房东电话，不留痕、不耗额度（与生产后端一致，避免开发者工具预览分叉）。
    if (listing && listing.uploaderId && String(listing.uploaderId) === String(state.currentUserId)) {
      var ownLoc = listingLocationFields(listing);
      return {
        logs: getListingLogs(listingId),
        sensitive: {
          city: ownLoc.city,
          district: ownLoc.district,
          area: ownLoc.area,
          areaText: ownLoc.city + ' · ' + ownLoc.area,
          block: ownLoc.block,
          community: ownLoc.community,
          building: ownLoc.building,
          unit: ownLoc.unit,
          roomNumber: ownLoc.roomNumber,
          locationSummary: ownLoc.locationSummary,
          roomAddress: ownLoc.roomAddress,
          address: listing.address,
          landlordPhone: listing.landlordPhone,
          viewingMethod: listingViewingMethodFields(listing).viewingMethod,
          viewingMethodText: listingViewingMethodFields(listing).viewingMethodText,
          viewingKeyLocation: firstText(listing.viewingKeyLocation, listing.keyLocation),
          viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
          sensitiveLocked: false,
          ownListing: true
        }
      };
    }
    var suppliedKey = String(data.idempotencyKey || '').trim();
    if (suppliedKey && (!/^[A-Za-z0-9:_-]{8,128}$/.test(suppliedKey) || /1[3-9]\d{9}/.test(suppliedKey))) {
      throw new Error('敏感查看幂等标识无效');
    }
    var key = suppliedKey || ('SV' + Date.now());
    var date = todayKey();
    var sameKeyExisting = (state.footprints || []).find(function (item) {
      return isSensitiveFootprint(item) && item.viewerId === state.currentUserId && item.listingId === listingId && item.idempotencyKey === key && footprintDateKey(item) === date;
    });
    var dailyExisting = sameKeyExisting || (state.footprints || []).find(function (item) {
      return isSensitiveFootprint(item) && item.viewerId === state.currentUserId && item.listingId === listingId && footprintDateKey(item) === date;
    });
    assertSensitiveViewerEligible();
    if (!sameKeyExisting) assertSensitiveViewQuotaAllowed(listing);
    if (!dailyExisting) {
      assertClientFootprintRateLimit(state.currentUserId, 'sensitive_view');
      pushExactFootprint({
        id: 'F' + Date.now(),
        listingId: listingId,
        viewerId: state.currentUserId,
        actionType: 'sensitive_view',
        idempotencyKey: key
      });
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
        viewingMethod: listingViewingMethodFields(listing).viewingMethod,
        viewingMethodText: listingViewingMethodFields(listing).viewingMethodText,
        viewingKeyLocation: firstText(listing.viewingKeyLocation, listing.keyLocation),
        viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
        sensitiveLocked: false
      } : {},
      quota: brokerSensitiveUsage(state.currentUserId)
    };
  }

  function recordPhoneCallOpened(listingId, payload) {
    if (!getUser()) throw new Error('请先登录内部中介账号');
    var key = String(payload && payload.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key) || /1[3-9]\d{9}/.test(key)) throw new Error('拨号记录幂等标识无效');
    var existing = state.footprints.find(function (item) {
      return item.actionType === 'phone_call_opened' && item.viewerId === state.currentUserId && item.listingId === listingId && item.idempotencyKey === key;
    });
    if (existing) return clone(existing);
    var listing = getListing(listingId);
    if (!listing || isExpiredListing(listing) || isPendingOwnerReview(listing)) throw new Error('该房源当前不可拨号');
    var allowed = isCompanyListing(listing) ||
      String(listing.uploaderId || '') === String(state.currentUserId || '') ||
      state.footprints.some(function (item) {
        return item.listingId === listingId && item.viewerId === state.currentUserId && isSensitiveFootprint(item);
      });
    if (!allowed) throw new Error('请先完成敏感信息查看确认');
    assertClientFootprintRateLimit(state.currentUserId, 'phone_call_opened');
    var record = {
      id: 'F' + Date.now(),
      viewerId: state.currentUserId,
      listingId: listingId,
      actionType: 'phone_call_opened',
      occurredAt: new Date().toISOString(),
      idempotencyKey: key
    };
    return clone(pushExactFootprint(record));
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
    assertClientFootprintRateLimit(user.id, 'video_shared');
    var location = publicListingLocationFields(listing);
    var title = publicListingTitle(listing, location) || listing.shortTitle || '房源视频';
    pushExactFootprint({
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
      pushExactFootprint({
        id: 'F' + Date.now(),
        listingId: showing.listingId,
        viewerId: showing.userId,
        action: '记录带看',
        needId: showing.needId || '',
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
    var sourceState = prepareSourceFields(form, {}, featureState);
    var communityReview = normalizeCommunityReviewState(form, {});
    var currentUser = getUser();
    var staffAutoApproved = shouldAutoApproveStaffListing(currentUser, sourceState);
    var needsReview = !staffAutoApproved && (sourceState.ownerType === OWNER_SOURCE || communityReview.requiresManualReview);
    var mapCoordinate = listingMapCoordinateFields(community, form, {});
    var viewingMethod = firstText(form.viewingMethod, form.showingMethod);
    var viewingKeyLocation = String(form.viewingKeyLocation || '').trim();
    var viewingPassword = String(form.viewingPassword || form.showingPassword || '').trim();
    var contact = firstText(form.contact, form.landlordPhone);
    var remark = normalizeListingRemark(firstOwnValue(form, ['remark', 'note', 'memo']));
    var landlordCommissionPercent = landlordCommissionPercentFrom(form, {});
    if (viewingMethod && VIEWING_METHOD_OPTIONS.indexOf(viewingMethod) === -1) {
      throw new Error('看房方式只能是钥匙、密码或联系房东');
    }
    if (!address || !form.rent || !layout || (!sourceState.companyListing && !hasListingVideo(form)) || !rawCommunity || !building || !roomNumber) {
      throw new Error('城市、区域、小区、几栋、房间号、租金和户型必填；业主、二房东房源还必须上传视频');
    }
    // 与生产后端同口径：合作房源所有方式必填；公司房源可空，非空时仍校验格式
    if (!sourceState.companyListing && !contact) {
      throw new Error('请填写房东手机号');
    }
    if (contact && !/^1[3-9]\d{9}$/.test(contact)) {
      throw new Error('请输入 11 位房东手机号');
    }
    if (viewingMethod === '钥匙' && !viewingKeyLocation) {
      throw new Error('看房方式为钥匙时，请填写钥匙在哪');
    }
    if (viewingMethod === '密码' && !viewingPassword) {
      throw new Error('看房方式为密码时，请填写看房密码');
    }
    if (Array.from(remark).length > 200) throw new Error('房源备注最多 200 字');
    if (listingRemarkContainsContact(remark)) throw new Error('房源备注不能包含手机号、微信号等联系方式');
    validateLandlordCommissionPercent(landlordCommissionPercent);
    if (!Number.isFinite(sourceState.commissionRate) || sourceState.commissionRate < 0 || sourceState.commissionRate > 100) {
      throw new Error('结算规则由当前配置和房源类型派生，当前历史佣金字段取值异常');
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
      landlordPhone: contact,
      remark: remark,
      landlordCommissionPercent: landlordCommissionPercent,
      viewingMethod: viewingMethod,
      viewingKeyLocation: viewingKeyLocation,
      viewingPassword: viewingPassword,
      showingPassword: viewingPassword,
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
    if (staffAutoApproved) applyStaffListingAutoApproval(listing, state.currentUserId);
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
      remark: listingRemarkContainsContact(listing.remark) ? '' : normalizeListingRemark(listing.remark),
      landlordCommissionPercent: landlordCommissionPercentFrom({}, listing),
      viewingMethod: listingViewingMethodFields(listing).viewingMethod,
      viewingMethodText: listingViewingMethodFields(listing).viewingMethodText,
      viewingKeyLocation: firstText(listing.viewingKeyLocation, listing.keyLocation),
      viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
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
    var featureState = normalizeFormFeatures(form, listing);
    var sourceState = prepareSourceFields(form, listing, featureState);
    var communityReview = normalizeCommunityReviewState(form, listing);
    var mapCoordinate = listingMapCoordinateFields(community, form, listing);
    var contactInput = firstOwnValue(form, ['contact', 'landlordPhone']);
    var nextContact = sourceState.companyListing && contactInput !== undefined
      ? String(contactInput === null || contactInput === undefined ? '' : contactInput).trim()
      : firstText(form.contact, form.landlordPhone, listing.landlordPhone);
    var nextVideoUrl = firstText(form.videoUrl, listing.videoUrl);
    var nextVideoKey = firstText(form.videoKey, listing.videoKey);
    var remarkInput = firstOwnValue(form, ['remark', 'note', 'memo']);
    var nextRemark = remarkInput !== undefined ? normalizeListingRemark(remarkInput) : normalizeListingRemark(listing.remark);
    var nextLandlordCommissionPercent = landlordCommissionPercentFrom(form, listing);
    if (!sourceState.companyListing && !nextContact) throw new Error('请填写房东手机号');
    if (nextContact && !/^1[3-9]\d{9}$/.test(nextContact)) throw new Error('请输入 11 位房东手机号');
    if (!sourceState.companyListing && !hasListingVideo({ videoUrl: nextVideoUrl, videoKey: nextVideoKey })) {
      throw new Error('二房东房源和业主房源必须上传真实视频，公司房源可不上传视频');
    }
    if (remarkInput !== undefined && Array.from(nextRemark).length > 200) throw new Error('房源备注最多 200 字');
    if (remarkInput !== undefined && listingRemarkContainsContact(nextRemark)) throw new Error('房源备注不能包含手机号、微信号等联系方式');
    validateLandlordCommissionPercent(nextLandlordCommissionPercent);
    if (!Number.isFinite(sourceState.commissionRate) || sourceState.commissionRate < 0 || sourceState.commissionRate > 100) {
      throw new Error('结算规则由当前配置和房源类型派生，当前历史佣金字段取值异常');
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
    if (Object.prototype.hasOwnProperty.call(form, 'viewingMethod')) {
      var nextViewingMethod = firstText(form.viewingMethod);
      if (nextViewingMethod && VIEWING_METHOD_OPTIONS.indexOf(nextViewingMethod) === -1) {
        throw new Error('看房方式只能是钥匙、密码或联系房东');
      }
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
    listing.landlordPhone = nextContact;
    listing.remark = nextRemark;
    listing.landlordCommissionPercent = nextLandlordCommissionPercent;
    // 显式传空串=清空、不传=沿用（与生产后端 normalizeListingForm 同语义）
    if (Object.prototype.hasOwnProperty.call(form, 'viewingMethod')) listing.viewingMethod = firstText(form.viewingMethod);
    if (Object.prototype.hasOwnProperty.call(form, 'viewingKeyLocation')) listing.viewingKeyLocation = String(form.viewingKeyLocation || '').trim();
    if (Object.prototype.hasOwnProperty.call(form, 'viewingPassword')) {
      listing.viewingPassword = String(form.viewingPassword || '').trim();
      listing.showingPassword = listing.viewingPassword;
    }
    listing.commissionRate = sourceState.commissionRate;
    listing.videoUrl = nextVideoUrl;
    listing.videoKey = nextVideoKey;
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
    if (!sourceState.companyListing) {
      delete listing.sourceType;
      delete listing.listingType;
      delete listing.inventoryType;
      delete listing.companyOwned;
    }
    listing.noCommission = sourceState.noCommission;
    listing.communityMatched = communityReview.communityMatched;
    listing.communityMatchStatus = communityReview.communityMatchStatus;
    listing.requiresManualReview = communityReview.requiresManualReview;
    listing.manualReviewReason = communityReview.manualReviewReason;
    listing.mapLatitude = mapCoordinate.mapLatitude;
    listing.mapLongitude = mapCoordinate.mapLongitude;
    listing.coordinateSource = mapCoordinate.coordinateSource;
    var currentUser = getUser();
    var staffAutoApproved = shouldAutoApproveStaffListing(currentUser, sourceState);
    var preserveStaffAutoApproval = Boolean(currentUser && currentUser.isAdmin) && isStaffAutoApprovedListing(listing) && !sourceState.companyListing;
    var autoApproved = staffAutoApproved || preserveStaffAutoApproval;
    var needsReview = !autoApproved && (sourceState.ownerType === OWNER_SOURCE || communityReview.requiresManualReview);
    if (autoApproved) {
      if (staffAutoApproved) applyStaffListingAutoApproval(listing, state.currentUserId);
      listing.reviewStatus = '已通过';
      if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认';
    } else if (needsReview) {
      clearStaffListingAutoApproval(listing);
      listing.reviewStatus = listing.reviewStatus === '已通过' && !communityReview.requiresManualReview ? '已通过' : '待审核';
      if (listing.reviewStatus !== '已通过') listing.status = '待审核';
    } else {
      clearStaffListingAutoApproval(listing);
      listing.reviewStatus = '无需审核';
      if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认';
    }
    syncListingRecommendationProfile(listing, needsReview && listing.reviewStatus !== '已通过' ? 'pending_review' : '');
    return getEditableListing(id);
  }

  function verifyMyListing(id, outcome) {
    var listing = getListing(id);
    if (listing && !isExpiredListing(listing)) {
      var normalized = String(outcome == null ? '' : outcome).trim();
      if (normalized === '已出租' || normalized === '不租了') {
        // 已出租/不租了 → 自动下架进后台资产池，下架原因分开记。
        listing.lifecycleStatus = 'expired';
        listing.status = '已下架';
        listing.expiredPool = '后台资产池';
        listing.expiredReason = normalized === '已出租' ? '房东反馈已出租' : '房东反馈不租了';
      } else {
        // 未出租（含缺省）→ 已维护，重置核验周期。
        assertListingVerificationAllowed(listing);
        listing.status = '在租';
        listing.lifecycleStatus = 'active';
        listing.lastVerifiedAt = '刚刚';
        syncListingRecommendationProfile(listing);
      }
    }
    return getOwnedListings();
  }

  function verifyAdminListing(id) {
    var listing = getListing(id);
    if (listing && !isExpiredListing(listing)) {
      assertListingVerificationAllowed(listing);
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
    pushExactFootprint({
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
    registerUser: registerUser,
    logout: logout,
    getHomeListings: function (filter) { return getListings(filter || {}).slice(0, 3); },
    getListings: getListings,
    getFavoriteIds: getFavoriteIds,
    getFavorites: getFavorites,
    setFavorite: setFavorite,
    matchListings: matchListings,
    getListingDetail: getListingDetail,
    getNearbyListings: getNearbyListings,
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
    getCommissionConfig: getCommissionConfig,
    updateCommissionConfig: updateCommissionConfig,
    getAdminLogs: getAdminLogs,
    getCommissionRows: getCommissionRows,
    getCommissionRecords: getCommissionRecords,
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
    recordPhoneCallOpened: recordPhoneCallOpened,
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
