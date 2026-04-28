# Secrets Hardening Report

**Version**: 1.0.0
**Date**: 2026-04-27
**Status**: Analysis Complete - Manual Action Required

---

## 1. Files Inspected

| File | Path | Secrets Found |
|------|------|-------------|
| settings.local.json | `~/.claude/settings.local.json` | 4 exposed secrets |
| .env | `~/.claude/.env` | None (existing secure) |

---

## 2. Secret-Like Values Found

### CRITICAL - GitHub Token (Line 21)
- **Type**: GitHub personal access token (`ghp_...`)
- **Risk**: HIGH - Can access/write to repositories
- **Exposure**: Hardcoded in allow list
- **Value**: [REDACTED - rotate immediately]

### HIGH - Hermes Adapter Token (Lines 37-38, 41, 43)
- **Type**: API token (Hermes adapter)
- **Risk**: HIGH - Can execute agent commands
- **Exposure**: Hardcoded in allow list
- **Value**: [REDACTED - rotate immediately]

### HIGH - OpenRouter API Key (Lines 39, 45, 47)
- **Type**: OpenRouter API key (`sk-or-v1-...`)
- **Risk**: HIGH - Can use paid AI services
- **Exposure**: Hardcoded in allow list
- **Value**: [REDACTED - rotate immediately]

### HIGH - Groq API Key (Line 52)
- **Type**: Groq API key (`gsk_...`)
- **Risk**: HIGH - Can use paid AI services
- **Exposure**: Hardcoded in allow list
- **Value**: [REDACTED - rotate immediately]

---

## 3. What Was Moved

**Status**: Nothing moved yet - manual action required

The above secrets are used in the Claude Code `allow` list, which means they're part of the permission system. Simply removing them could break functionality.

---

## 4. What Needs Manual Rotation

### Step 1: Rotate GitHub Token
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate new token with same permissions
3. Update the token in settings.local.json (line 21)
4. Or migrate to `.env` and reference via env var

### Step 2: Rotate OpenRouter Key
1. Go to openrouter.ai → Account → API Keys
2. Generate new key
3. Update settings.local.json (lines 39, 45, 47)
4. Or migrate to `.env`

### Step 3: Rotate Groq Key
1. Go to console.groq.com → API Keys
2. Generate new key
3. Update settings.local.json (line 52)
4. Or migrate to `.env`

### Step 4: Rotate Hermes Adapter Token
1. Check Hermes daemon config for token generation
2. Regenerate token
3. Update settings.local.json (lines 37-38, 41, 43)
4. Or migrate to `.env`

---

## 5. .env Example Template

```bash
# Claude Code / Mission Control Environment
# Copy this to .env and fill in values

# GitHub
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenRouter
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Groq
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Hermes
HERMES_ADAPTER_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 6. Risk Level Summary

| Item | Current Risk | Action Required |
|------|--------------|-----------------|
| GitHub token | CRITICAL | Rotate immediately |
| OpenRouter key | HIGH | Rotate within 24h |
| Groq key | HIGH | Rotate within 24h |
| Hermes token | HIGH | Rotate within 24h |

**Overall Risk Level**: CRITICAL

---

## 7. Recommendations

1. **DO NOT** simply delete these tokens - functionality will break
2. **DO** rotate each token one at a time
3. **DO** migrate to `.env` variables over time
4. **DO** use a password manager for secure storage
5. **DO NOT** commit any of these files to git

---

## 8. After Rotation

Once all tokens are rotated and in `.env`:
1. Remove hardcoded values from settings.local.json
2. Update allow list to reference env vars
3. Verify all functionality still works
4. Test each service individually