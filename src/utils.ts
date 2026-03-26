import {create} from '@actions/glob'
import {copyFile, readFile, writeFile, mkdir} from 'fs/promises'
import {existsSync} from 'fs'
import deepmerge from 'deepmerge'
import {rmRF} from '@actions/io'
import {copySync} from 'fs-extra'
import {debug, info} from '@actions/core'
import {
  ShopifySettingsOrTemplateJSON,
  ISyncLocalJSONWithRemoteJSONForStore
} from './types.d'
import {ExecException, exec as nativeExec} from 'child_process'
import JSONParser from 'json-parse-safe'
import {dirname, relative} from 'path'

export const EXEC_OPTIONS = {
  listeners: {
    stdout: (data: Buffer) => {
      debug(data.toString())
    },
    stderr: (data: Buffer) => {
      info(data.toString())
    }
  }
}

export const fetchFiles = async (pattern: string): Promise<string[]> => {
  const globber = await create(pattern)
  const files = await globber.glob()
  return files
}

const fetchLocalFileForRemoteFile = async (
  remoteFile: string
): Promise<string> => {
  const localFile = remoteFile.replace(`${process.cwd()}/remote/`, 'remote/')
  return localFile.replace('remote/', '')
}

// Remove this from JSONString before parsing
// /*
// * ------------------------------------------------------------
// * IMPORTANT: The contents of this file are auto-generated.
// *
// * This file may be updated by the Shopify admin language editor
// * or related systems. Please exercise caution as any changes
// * made to this file may be overwritten.
// * ------------------------------------------------------------
// */

const cleanJSONStringofShopifyComment = (
  jsonString: string
): ShopifySettingsOrTemplateJSON => {
  try {
    const parsed = JSONParser(jsonString)
    if (parsed && 'value' in parsed) {
      return parsed.value as ShopifySettingsOrTemplateJSON
    }

    throw new Error('JSON Parse Error')
  } catch (error) {
    if (error instanceof Error) {
      debug(error.message)
    }
    return JSON.parse(jsonString)
  }
}

export const readJsonFile = async (
  file: string
): Promise<ShopifySettingsOrTemplateJSON> => {
  if (!existsSync(file)) {
    return {} // Return empty object if file doesn't exist
  }
  const buffer = await readFile(file)
  return cleanJSONStringofShopifyComment(buffer.toString())
}

export const cleanRemoteFiles = async (): Promise<void> => {
  const remoteDir = 'remote'

  if (!existsSync(remoteDir)) {
    debug(
      `Skipping cleanRemoteFiles: ${remoteDir} directory not found, creating it`
    )
    await mkdir(remoteDir, {recursive: true})
    return
  }

  try {
    await rmRF(remoteDir)
  } catch (error) {
    if (error instanceof Error) debug(error.message)
  }
}

// 10MB buffer - Shopify CLI --verbose output can exceed Node's default 1MB
const EXEC_MAX_BUFFER = 10 * 1024 * 1024

export async function execShellCommand(cmd: string): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    nativeExec(
      cmd,
      {maxBuffer: EXEC_MAX_BUFFER},
      (error: ExecException | null, stdout: string, stderr: string) => {
        if (error) {
          return reject(error)
        }
        resolve(stdout ? stdout : stderr)
      }
    )
  })
}

export const validateShopifyCliAccess = async (
  store: string,
  execCommand: (cmd: string) => Promise<string | Buffer> = execShellCommand
): Promise<void> => {
  try {
    await execCommand('shopify version')
  } catch (error) {
    throw new Error(
      'Shopify CLI is not available on PATH. Install it before running this action.'
    )
  }

  try {
    await execCommand(`shopify theme list --store ${store}`)
  } catch (error) {
    throw new Error(
      `Shopify CLI could not access store "${store}". Verify CLI authentication and store permissions before running this action.`
    )
  }
}

export const sendFilesWithPathToShopify = async (
  files: string[],
  {targetThemeId, store}: ISyncLocalJSONWithRemoteJSONForStore
): Promise<string[]> => {
  if (files.length === 0) {
    debug('No files to push to Shopify')
    return []
  }

  for (const file of files) {
    debug(`Pushing ${file} to Shopify`)
  }
  const pushOnlyCommand = files
    .map(
      file => `--only=${relative(process.cwd(), file).replace(/\\/g, '/')}`
    )
    .join(' ')
  debug(`Push Only Command: ${pushOnlyCommand}`)
  for (const file of files) {
    const baseFile = relative(process.cwd(), file)
    const destination = `${process.cwd()}/remote/new/${baseFile}`
    await mkdir(dirname(destination), {recursive: true})
    debug(`Copying ${file} to ${destination}`)
    copySync(file, destination, {
      overwrite: true
    })
  }

  await execShellCommand(
    `shopify theme ${[
      'push',
      pushOnlyCommand,
      '--theme',
      targetThemeId,
      '--store',
      store,
      '--verbose',
      '--path',
      'remote/new',
      '--nodelete'
    ].join(' ')}`
  )

  return files
}

// Go throgh all keys in the object and a key which has disabled: true, remove it from the object
export const removeDisabledKeys = (
  obj: ShopifySettingsOrTemplateJSON
): ShopifySettingsOrTemplateJSON => {
  const newObj = {...obj}
  for (const key in obj) {
    const value = newObj[key]
    if (
      value &&
      typeof value === 'object' &&
      'disabled' in value &&
      value.disabled === true
    ) {
      delete newObj[key]
    }
  }
  return newObj
}

const mergeOptions = {
  arrayMerge: (_: unknown[], sourceArray: unknown[]) => sourceArray,
  customMerge: (key: string) => {
    if (key === 'blocks') {
      return (_: unknown, newBlocks: ShopifySettingsOrTemplateJSON) =>
        removeDisabledKeys(newBlocks)
    }
    return undefined
  }
}

/**
 * Deep-merge pulled files under `remote/` into matching repo paths.
 * Remote wins on conflicting keys; keys that exist only in the repo are kept.
 */
export const mergeRemoteJsonPathsIntoLocal = async (
  remotePatterns: string[]
): Promise<string[]> => {
  const remoteFiles = await fetchFiles(remotePatterns.join('\n'))

  for (const path of remoteFiles) {
    debug(`Remote File: ${path}`)
  }
  const localFilesToPush: string[] = []
  for (const file of remoteFiles) {
    try {
      const remoteJson = await readJsonFile(file)
      debug(`Remote File: ${file}`)

      const localFileRef = await fetchLocalFileForRemoteFile(file)
      debug(`Local File Ref: ${localFileRef}`)
      const localJson = await readJsonFile(localFileRef)

      const mergedFile = deepmerge(localJson, remoteJson, mergeOptions)

      await mkdir(dirname(localFileRef), {recursive: true})
      await writeFile(localFileRef, JSON.stringify(mergedFile, null, 2))
      localFilesToPush.push(localFileRef)
    } catch (error) {
      if (error instanceof Error) {
        debug('Error in mergeRemoteJsonPathsIntoLocal')
        debug(error.message)
      }
      continue
    }
  }

  return localFilesToPush
}

export const syncLocaleAndSettingsJSON = async ({
  includeSettingsData = true
}: {
  includeSettingsData?: boolean
} = {}): Promise<string[]> => {
  const remotePatterns = ['./remote/locales/*.json']
  if (includeSettingsData) {
    remotePatterns.push('./remote/config/*_data.json')
  }

  return mergeRemoteJsonPathsIntoLocal(remotePatterns)
}

/**
 * Overwrite templates/ with copies of pulled remote/templates (no merge).
 * Local-only templates (not present under remote after pull) are unchanged here;
 * they are pushed separately via getNewTemplatesToRemote.
 */
export const syncTemplateJSON = async (): Promise<string[]> => {
  const remoteFiles = await fetchFiles('./remote/templates/**/*.json')
  const localFilesToPush: string[] = []

  for (const file of remoteFiles) {
    try {
      debug(`Remote template: ${file}`)
      const localFileRef = await fetchLocalFileForRemoteFile(file)
      await mkdir(dirname(localFileRef), {recursive: true})
      await copyFile(file, localFileRef)
      localFilesToPush.push(localFileRef)
    } catch (error) {
      if (error instanceof Error) {
        debug('Error in syncTemplateJSON')
        debug(error.message)
      }
      continue
    }
  }

  return localFilesToPush
}

export const getNewTemplatesToRemote = async (): Promise<string[]> => {
  const remoteTemplateFilesNames = (
    (await fetchFiles('./remote/templates/**/*.json')) || []
  ).map(file =>
    file.replace(`${process.cwd()}/remote/`, 'remote/').replace('remote/', '')
  )

  const localTemplateFiles = await fetchFiles('./templates/**/*.json')
  const localeFilesToMove = localTemplateFiles
    .map(file => file.replace(`${process.cwd()}/`, ''))
    .filter(file => !remoteTemplateFilesNames.includes(file))

  return localeFilesToMove
}
