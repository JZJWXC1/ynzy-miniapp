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
    latitude: 30.323286,
    longitude: 120.191643,
    source: 'estimated-by-yangjia-qinyuan'
  },
  华丰欣苑: {
    latitude: 30.337823,
    longitude: 120.200076,
    source: 'lianjia-bd09-to-gcj02'
  },
  石桥铭苑: {
    latitude: 30.342859,
    longitude: 120.190776,
    source: 'estimated-by-shiqiao-road'
  },
  永佳新苑: {
    latitude: 30.344938,
    longitude: 120.189903,
    source: 'lianjia-bd09-to-gcj02'
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

function coordinateByCommunity(name) {
  const entry = communityCoordinateEntry(name)
  if (!entry) return null
  const coordinate = entry.coordinate
  if (!coordinate) return null
  return {
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    source: coordinate.source,
    community: entry.key
  }
}

module.exports = {
  communityCoordinates,
  normalizeCommunityName,
  coordinateByCommunity
}
