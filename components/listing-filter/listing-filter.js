function cleanValue(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeFilters(value = {}) {
  return {
    needId: cleanValue(value.needId || value.rentalNeedId || value.clientNeedId),
    district: cleanValue(value.district || value.area),
    block: cleanValue(value.block),
    community: cleanValue(value.community),
    layout: cleanValue(value.layout),
    rentMin: cleanValue(value.rentMin),
    rentMax: cleanValue(value.rentMax),
    rentMode: cleanValue(value.rentMode)
  }
}

function blocksForDistrict(regionOptions = [], district) {
  if (!district) {
    return regionOptions.reduce((list, item) => list.concat(item.blocks || []), [])
  }
  const matched = regionOptions.find((item) => item.name === district)
  return matched ? (matched.blocks || []) : []
}

function visibleCommunities(options = [], keyword) {
  const text = String(keyword || '').trim()
  const rows = text ? options.filter((item) => String(item).indexOf(text) !== -1) : options
  return rows.slice(0, 8)
}

Component({
  properties: {
    filters: {
      type: Object,
      value: {},
      observer(value) {
        this.refreshDraft(value)
      }
    },
    regionOptions: {
      type: Array,
      value: [],
      observer() {
        this.refreshOptions()
      }
    },
    communityOptions: {
      type: Array,
      value: [],
      observer() {
        this.refreshOptions()
      }
    },
    layoutOptions: {
      type: Array,
      value: ['不限', '一室', '两室', '三室', '三室以上']
    },
    loading: {
      type: Boolean,
      value: false
    }
  },
  data: {
    draftFilters: normalizeFilters({}),
    blockOptions: [],
    visibleCommunityOptions: [],
    showCommunityOptions: false
  },
  lifetimes: {
    attached() {
      this.refreshDraft(this.data.filters)
    }
  },
  methods: {
    refreshDraft(value) {
      const draftFilters = normalizeFilters(value)
      this.setData({
        draftFilters,
        blockOptions: blocksForDistrict(this.data.regionOptions, draftFilters.district),
        visibleCommunityOptions: visibleCommunities(this.data.communityOptions, draftFilters.community)
      })
    },
    refreshOptions() {
      const draftFilters = normalizeFilters(this.data.draftFilters)
      this.setData({
        blockOptions: blocksForDistrict(this.data.regionOptions, draftFilters.district),
        visibleCommunityOptions: visibleCommunities(this.data.communityOptions, draftFilters.community)
      })
    },
    updateDraft(nextFilters, immediate) {
      const draftFilters = normalizeFilters(nextFilters)
      this.setData({
        draftFilters,
        blockOptions: blocksForDistrict(this.data.regionOptions, draftFilters.district),
        visibleCommunityOptions: visibleCommunities(this.data.communityOptions, draftFilters.community)
      })
      this.triggerEvent('filterchange', {
        filters: draftFilters,
        immediate: Boolean(immediate)
      })
    },
    selectDistrict(event) {
      const district = event.currentTarget.dataset.district || ''
      this.updateDraft({
        ...this.data.draftFilters,
        district,
        block: '',
        community: ''
      }, true)
    },
    selectBlock(event) {
      const block = event.currentTarget.dataset.block || ''
      this.updateDraft({
        ...this.data.draftFilters,
        block,
        community: ''
      }, true)
    },
    selectLayout(event) {
      const layout = event.currentTarget.dataset.layout || ''
      this.updateDraft({
        ...this.data.draftFilters,
        layout: layout === '不限' ? '' : layout
      }, true)
    },
    selectRentMode(event) {
      const rentMode = event.currentTarget.dataset.rentmode || ''
      this.updateDraft({
        ...this.data.draftFilters,
        rentMode
      }, true)
    },
    updateInput(event) {
      const field = event.currentTarget.dataset.field
      if (!field) return
      this.updateDraft({
        ...this.data.draftFilters,
        [field]: event.detail.value
      }, false)
      if (field === 'community') {
        this.setData({ showCommunityOptions: true })
      }
    },
    focusCommunity() {
      this.setData({
        showCommunityOptions: true,
        visibleCommunityOptions: visibleCommunities(this.data.communityOptions, this.data.draftFilters.community)
      })
    },
    selectCommunity(event) {
      const community = event.currentTarget.dataset.community || ''
      this.setData({ showCommunityOptions: false })
      this.updateDraft({
        ...this.data.draftFilters,
        community
      }, true)
    },
    applyFilters() {
      this.triggerEvent('filterapply', {
        filters: normalizeFilters(this.data.draftFilters)
      })
    },
    resetFilters() {
      this.setData({ showCommunityOptions: false })
      this.triggerEvent('filterreset')
    }
  }
})
