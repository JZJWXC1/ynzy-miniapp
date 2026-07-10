function findFailedCoverIndex(listings, listingId, failedCoverUrl) {
  if (!Array.isArray(listings)) return -1
  const id = String(listingId == null ? '' : listingId).trim()
  const coverUrl = String(failedCoverUrl == null ? '' : failedCoverUrl)
  if (!id || !coverUrl) return -1

  return listings.findIndex((item) => {
    if (!item) return false
    return String(item.id == null ? '' : item.id).trim() === id &&
      String(item.coverUrl == null ? '' : item.coverUrl) === coverUrl
  })
}

module.exports = {
  findFailedCoverIndex
}
