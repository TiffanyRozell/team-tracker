import { ref, computed } from 'vue'
import { getGitlabContributions, refreshGitlabContributions, refreshGitlabContribution } from '../services/api'

const gitlabData = ref(null)
const loading = ref(false)

export function useGitlabStats() {
  const contributionsMap = computed(() => {
    if (!gitlabData.value?.users) return {}
    return gitlabData.value.users
  })

  function getContributions(gitlabUsername) {
    if (!gitlabUsername) return null
    return contributionsMap.value[gitlabUsername] || null
  }

  async function loadGitlabStats() {
    if (gitlabData.value) return
    loading.value = true
    try {
      await getGitlabContributions((data) => {
        gitlabData.value = data
        loading.value = false
      })
    } catch (err) {
      console.error('Failed to load GitLab stats:', err)
    } finally {
      loading.value = false
    }
  }

  async function refreshStats() {
    loading.value = true
    try {
      await refreshGitlabContributions()
      // Wait a moment for the background job to process, then reload
      setTimeout(async () => {
        try {
          gitlabData.value = await getGitlabContributions()
        } finally {
          loading.value = false
        }
      }, 5000)
    } catch (err) {
      console.error('Failed to refresh GitLab stats:', err)
      loading.value = false
    }
  }

  async function refreshUserStats(username) {
    if (!username) return null
    try {
      const data = await refreshGitlabContribution(username)
      if (data && gitlabData.value) {
        if (!gitlabData.value.users) gitlabData.value.users = {}
        gitlabData.value.users[username] = data
      }
      return data
    } catch (err) {
      console.error('Failed to refresh GitLab stats for', username, err)
      return null
    }
  }

  return {
    contributionsMap,
    getContributions,
    loadGitlabStats,
    refreshStats,
    refreshUserStats,
    loading
  }
}
