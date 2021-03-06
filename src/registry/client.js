const drc = require('docker-registry-client');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const path = require('path');
const sh = require('shelljs');
const log = require('../utils/logger');
const config = require('../config');
const { retryAsync } = require('../utils');

const registrySecretsPath = '/run/secrets/registries/';

/** Registry Client for a particular image reference (promisified docker-registry-client) * */
class RegistryClient {
  constructor(repo) {
    this.repo = repo;
    const repoAndRef = drc.parseRepoAndRef(repo);
    const registry = repoAndRef.index.name;
    const clientConfig = { name: repo };

    // Look for matching secrets
    if (fs.existsSync(path.join(registrySecretsPath, registry))) {
      log.debug(`Found registry credentials for ${registry}`);
      const auth = yaml.safeLoad(
        fs.readFileSync(path.join(registrySecretsPath, registry), 'utf8')
      );
      if (auth && auth.username && auth.password) {
        // Use `docker login` to test credentials,
        // And to create entry in ~/.docker/config.json which will be used by SP
        if (
          sh.exec(`docker login ${registry} -u ${auth.username} -p ${auth.password}`, {
            silent: true
          }).code === 0
        ) {
          clientConfig.username = auth.username;
          clientConfig.password = auth.password;
        } else {
          log.warn(`Could not login to ${registry} with credentials`);
        }
      } else {
        log.warn(`Invalid format for ${path.join(registrySecretsPath, registry)}`);
      }
    }

    this.drc = drc.createClientV2(clientConfig);
  }

  async listTags() {
    return new Promise((resolve, reject) => {
      this.drc.listTags((err, response) => (err ? reject(err) : resolve(response.tags)));
    });
  }

  async getManifest(opts) {
    return retryAsync(
      this._getManifest.bind(this),
      { delay: config.docker.minRegistryReqInterval },
      opts
    );
  }

  async _getManifest(opts) {
    const that = this;
    return new Promise((resolve, reject) => {
      log.info(`fetching manifest for ${opts.ref}`);
      that.drc.getManifest(opts, (err, response) =>
        err ? reject(err) : resolve(response)
      );
    });
  }

  async getCreated({ ref }) {
    const manifest = await this.getManifest({
      ref,
      acceptManifestLists: true,
      maxSchemaVersion: 1
    });
    if (manifest && manifest.history && manifest.history[0].v1Compatibility) {
      const v1Manifest = JSON.parse(manifest.history[0].v1Compatibility);
      return new Date(v1Manifest.created);
    }
    return null;
  }
}

module.exports = RegistryClient;
