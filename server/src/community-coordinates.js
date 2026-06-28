const communityCoordinates = {
  京漾东韵府: {
    latitude: 30.280809,
    longitude: 120.201453,
    source: 'lianjia-bd09-to-gcj02'
  },
  骏塘名庭: {
    latitude: 30.282157,
    longitude: 120.215869,
    source: 'lianjia-bd09-to-gcj02'
  },
  翰皋名府: {
    latitude: 30.280384,
    longitude: 120.211055,
    source: 'lianjia-bd09-to-gcj02'
  },
  皋塘运都: {
    latitude: 30.281799,
    longitude: 120.213997,
    source: 'hangzhou-rentals-amap'
  },
  长木府: {
    latitude: 30.304535,
    longitude: 120.177467,
    source: 'lianjia-bd09-to-gcj02'
  },
  长浜龙吟轩: {
    latitude: 30.309357,
    longitude: 120.184283,
    source: 'amap-poi-B0K6U5MNPA'
  },
  香柠颜家府: {
    latitude: 30.307094,
    longitude: 120.176774,
    source: 'lianjia-bd09-to-gcj02'
  },
  杨乐府: {
    latitude: 30.303432,
    longitude: 120.168634,
    source: 'lianjia-bd09-to-gcj02'
  },
  长岳王马府: {
    latitude: 30.295281,
    longitude: 120.175526,
    source: 'lianjia-bd09-to-gcj02'
  },
  兴业杨家府: {
    latitude: 30.32315,
    longitude: 120.198637,
    source: 'amap-poi-B0MA5XR20Z'
  },
  杨家新雅苑: {
    latitude: 30.319816,
    longitude: 120.190283,
    source: 'amap-poi-B0MB4KYB67'
  },
  琬秋铭府: {
    latitude: 30.287781,
    longitude: 120.196655,
    source: 'amap-poi-B0KKK5QPUI'
  },
  华丰欣苑: {
    latitude: 30.337823,
    longitude: 120.200076,
    source: 'lianjia-bd09-to-gcj02'
  },
  华丰新苑: {
    latitude: 30.338453,
    longitude: 120.199293,
    source: 'amap-poi-B0L6SY3412'
  },
  石桥铭苑: {
    latitude: 30.332732,
    longitude: 120.190706,
    source: 'amap-poi-B0L16HRS32'
  },
  永佳新苑: {
    latitude: 30.344938,
    longitude: 120.189903,
    source: 'lianjia-bd09-to-gcj02'
  },
  永佳欣苑: {
    latitude: 30.344415,
    longitude: 120.189613,
    source: 'amap-poi-B0LB2ZPTD0'
  },
  中融城市花园: {
    latitude: 30.272679,
    longitude: 120.128231,
    source: 'lianjia-bd09-to-gcj02'
  },
  大华海派风景: {
    latitude: 30.345286,
    longitude: 120.121984,
    source: 'lianjia-bd09-to-gcj02'
  },
  星桥锦绣嘉苑: {
    latitude: 30.330332,
    longitude: 120.113377,
    source: 'lianjia-bd09-to-gcj02'
  },
  孔家埭和府: {
    latitude: 30.330706,
    longitude: 120.098179,
    source: 'lianjia-bd09-to-gcj02'
  },
  合嵣悦府: {
    latitude: 30.357956,
    longitude: 120.071333,
    source: 'lianjia-bd09-to-gcj02'
  },
  臻棠樾府: {
    latitude: 30.328821,
    longitude: 120.151128,
    source: 'lianjia-bd09-to-gcj02'
  },
  万融城: {
    latitude: 30.333846,
    longitude: 120.127299,
    source: 'lianjia-bd09-to-gcj02'
  },
  吉如家园: {
    latitude: 30.31814,
    longitude: 120.129706,
    source: 'lianjia-bd09-to-gcj02'
  },
  棠润府: {
    latitude: 30.336618,
    longitude: 120.129081,
    source: 'lianjia-bd09-to-gcj02'
  },
  白田畈龙吟府: {
    latitude: 30.300532,
    longitude: 120.191573,
    source: 'amap-poi-B0KDBHKX6N'
  },
  嘉樘星绣府: {
    latitude: 30.317987,
    longitude: 120.184781,
    source: 'amap-poi-B0JKVRM87Y'
  },
  嘉橖星绣府: {
    latitude: 30.317987,
    longitude: 120.184781,
    source: 'amap-poi-B0JKVRM87Y'
  },
  小洋坝家园二区: {
    latitude: 30.347765,
    longitude: 120.102918,
    source: 'amap-poi-B0I637WD1Z'
  },
  昌运里三区: {
    latitude: 30.342866,
    longitude: 120.131563,
    source: 'amap-poi-B0J6VZ5YOP'
  }
}

function normalizeCommunityName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(杭州市?|杭州)?(上城区|拱墅区|西湖区|滨江区|萧山区|余杭区|临平区|钱塘区)/, '')
}

function communityCoordinateEntry(name) {
  const key = String(name || '').trim()
  if (communityCoordinates[key]) return { key, coordinate: communityCoordinates[key] }

  const normalized = normalizeCommunityName(name)
  if (!normalized) return null
  const matchedKey = Object.keys(communityCoordinates)
    .sort((left, right) => normalizeCommunityName(right).length - normalizeCommunityName(left).length)
    .find((item) => {
      const itemName = normalizeCommunityName(item)
      return normalized === itemName ||
        normalized.indexOf(itemName) !== -1 ||
        (normalized.length >= 3 && itemName.indexOf(normalized) !== -1)
    })
  return matchedKey ? { key: matchedKey, coordinate: communityCoordinates[matchedKey] } : null
}

function isReliableCoordinateSource(source) {
  const text = String(source || '').trim().toLowerCase()
  if (!text) return false
  return !/estimated|estimate|hash|random|default|offset|scatter|legacy|area|pending/.test(text)
}

function coordinateByCommunity(name) {
  const entry = communityCoordinateEntry(name)
  if (!entry) return null
  const coordinate = entry.coordinate
  if (!coordinate) return null
  if (!isReliableCoordinateSource(coordinate.source)) return null
  return {
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    source: coordinate.source,
    community: entry.key,
    coordinateVerified: true
  }
}

module.exports = {
  communityCoordinates,
  normalizeCommunityName,
  isReliableCoordinateSource,
  coordinateByCommunity
}
