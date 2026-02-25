import { ref } from 'vue'
import {
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged
} from 'firebase/auth'
import { auth, googleProvider } from '../config/firebase'

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT || '/api'

const user = ref(null)
const loading = ref(true)
const error = ref(null)
const allowlistDenied = ref(false)

let unsubscribe = null

export function useAuth() {
  // Initialize auth state listener if not already done
  if (!unsubscribe) {
    unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Check if email is from redhat.com domain
        if (!firebaseUser.email.endsWith('@redhat.com')) {
          error.value = 'Access denied. Only @redhat.com email addresses are allowed.'
          await firebaseSignOut(auth)
          user.value = null
          loading.value = false
          return
        }

        // Valid domain — check allowlist
        user.value = firebaseUser
        error.value = null

        try {
          const token = await firebaseUser.getIdToken()
          const res = await fetch(`${API_ENDPOINT}/allowlist`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          if (res.status === 403) {
            allowlistDenied.value = true
          } else {
            allowlistDenied.value = false
          }
        } catch {
          // Network error in dev — don't block if server isn't running
          allowlistDenied.value = false
        }
      } else {
        user.value = null
        allowlistDenied.value = false
      }

      loading.value = false
    })
  }

  const signIn = async () => {
    try {
      error.value = null
      loading.value = true
      await signInWithPopup(auth, googleProvider)
    } catch (err) {
      console.error('Sign-in error:', err)
      if (err.code === 'auth/popup-closed-by-user') {
        error.value = 'Sign-in cancelled. Please try again.'
      } else if (err.code === 'auth/popup-blocked') {
        error.value = 'Pop-up blocked by browser. Please allow pop-ups and try again.'
      } else {
        error.value = `Sign-in failed: ${err.message}`
      }
      loading.value = false
    }
  }

  const signOut = async () => {
    try {
      error.value = null
      await firebaseSignOut(auth)
    } catch (err) {
      console.error('Sign-out error:', err)
      error.value = `Sign-out failed: ${err.message}`
    }
  }

  const getIdToken = async () => {
    if (!user.value) {
      throw new Error('No user signed in')
    }

    try {
      const token = await user.value.getIdToken()
      return token
    } catch (err) {
      console.error('Failed to get ID token:', err)
      throw err
    }
  }

  return {
    user,
    loading,
    error,
    allowlistDenied,
    signIn,
    signOut,
    getIdToken
  }
}
