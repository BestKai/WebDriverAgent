import _ from 'lodash';
import path from 'path';
import url from 'url';
import B from 'bluebird';
import { JWProxy } from '@appium/base-driver';
import { fs, util, plist } from '@appium/support';
import defaultLogger from './logger';
import { NoSessionProxy } from './no-session-proxy';
import {
  getWDAUpgradeTimestamp, resetTestProcesses, getPIDsListeningOnPort, BOOTSTRAP_PATH
} from './utils';
import XcodeBuild from './xcodebuild';
import AsyncLock from 'async-lock';
import { exec } from 'teen_process';
import { bundleWDASim } from './check-dependencies';
import {
  WDA_RUNNER_BUNDLE_ID, WDA_RUNNER_BUNDLE_ID_FOR_XCTEST, WDA_RUNNER_APP,
  WDA_BASE_URL, WDA_UPGRADE_TIMESTAMP_PATH
} from './constants';
import {Xctest} from 'appium-ios-device';
import {strongbox} from '@appium/strongbox';

const WDA_LAUNCH_TIMEOUT = 60 * 1000;
const WDA_AGENT_PORT = 8100;
const WDA_CF_BUNDLE_NAME = 'WebDriverAgentRunner-Runner';
const SHARED_RESOURCES_GUARD = new AsyncLock();
const RECENT_MODULE_VERSION_ITEM_NAME = 'recentWdaModuleVersion';

class WebDriverAgent {
  constructor (xcodeVersion, args = {}, log = null) {
    this.xcodeVersion = xcodeVersion;

    this.args = _.clone(args);
    this.log = log ?? defaultLogger;

    this.device = args.device;
    this.platformVersion = args.platformVersion;
    this.platformName = args.platformName;
    this.iosSdkVersion = args.iosSdkVersion;
    this.host = args.host;
    this.isRealDevice = !!args.realDevice;
    this.idb = (args.device || {}).idb;
    this.wdaBundlePath = args.wdaBundlePath;

    this.setWDAPaths(args.bootstrapPath, args.agentPath);

    this.wdaLocalPort = args.wdaLocalPort;
    this.wdaRemotePort = args.wdaLocalPort || WDA_AGENT_PORT;
    this.wdaBaseUrl = args.wdaBaseUrl || WDA_BASE_URL;

    this.prebuildWDA = args.prebuildWDA;

    // this.args.webDriverAgentUrl guiarantees the capabilities acually
    // gave 'appium:webDriverAgentUrl' but 'this.webDriverAgentUrl'
    // could be used for caching WDA with xcodebuild.
    this.webDriverAgentUrl = args.webDriverAgentUrl;

    this.started = false;

    this.wdaConnectionTimeout = args.wdaConnectionTimeout;

    this.useXctestrunFile = args.useXctestrunFile;
    this.usePrebuiltWDA = args.usePrebuiltWDA;
    this.derivedDataPath = args.derivedDataPath;
    this.mjpegServerPort = args.mjpegServerPort;

    this.updatedWDABundleId = args.updatedWDABundleId;

    this.usePreinstalledWDA = args.usePreinstalledWDA;
    this.xctestApiClient = null;

    this.xcodebuild = this.canSkipXcodebuild
    ? null
    : new XcodeBuild(this.xcodeVersion, this.device, {
        platformVersion: this.platformVersion,
        platformName: this.platformName,
        iosSdkVersion: this.iosSdkVersion,
        agentPath: this.agentPath,
        bootstrapPath: this.bootstrapPath,
        realDevice: this.isRealDevice,
        showXcodeLog: args.showXcodeLog,
        xcodeConfigFile: args.xcodeConfigFile,
        xcodeOrgId: args.xcodeOrgId,
        xcodeSigningId: args.xcodeSigningId,
        keychainPath: args.keychainPath,
        keychainPassword: args.keychainPassword,
        useSimpleBuildTest: args.useSimpleBuildTest,
        usePrebuiltWDA: args.usePrebuiltWDA,
        updatedWDABundleId: this.updatedWDABundleId,
        launchTimeout: args.wdaLaunchTimeout || WDA_LAUNCH_TIMEOUT,
        wdaRemotePort: this.wdaRemotePort,
        useXctestrunFile: this.useXctestrunFile,
        derivedDataPath: args.derivedDataPath,
        mjpegServerPort: this.mjpegServerPort,
        allowProvisioningDeviceRegistration: args.allowProvisioningDeviceRegistration,
        resultBundlePath: args.resultBundlePath,
        resultBundleVersion: args.resultBundleVersion,
      }, this.log);
  }

  /**
   * Return true if the session does not need xcodebuild.
   * @returns {boolean} Whether the session needs/has xcodebuild.
   */
  get canSkipXcodebuild () {
    // Use this.args.webDriverAgentUrl to guarantee
    // the capabilities set gave the `appium:webDriverAgentUrl`.
    return this.usePreinstalledWDA || this.args.webDriverAgentUrl;
  }

  /**
   *
   * @returns {string} Bundle ID for Xctest.
   */
  get bundleIdForXctest () {
    return this.updatedWDABundleId ? `${this.updatedWDABundleId}.xctrunner` : WDA_RUNNER_BUNDLE_ID_FOR_XCTEST;
  }

  setWDAPaths (bootstrapPath, agentPath) {
    // allow the user to specify a place for WDA. This is undocumented and
    // only here for the purposes of testing development of WDA
    this.bootstrapPath = bootstrapPath || BOOTSTRAP_PATH;
    this.log.info(`Using WDA path: '${this.bootstrapPath}'`);

    // for backward compatibility we need to be able to specify agentPath too
    this.agentPath = agentPath || path.resolve(this.bootstrapPath, 'WebDriverAgent.xcodeproj');
    this.log.info(`Using WDA agent: '${this.agentPath}'`);
  }

  async cleanupObsoleteProcesses () {
    const obsoletePids = await getPIDsListeningOnPort(this.url.port,
      (cmdLine) => cmdLine.includes('/WebDriverAgentRunner') &&
        !cmdLine.toLowerCase().includes(this.device.udid.toLowerCase()));

    if (_.isEmpty(obsoletePids)) {
      this.log.debug(`No obsolete cached processes from previous WDA sessions ` +
        `listening on port ${this.url.port} have been found`);
      return;
    }

    this.log.info(`Detected ${obsoletePids.length} obsolete cached process${obsoletePids.length === 1 ? '' : 'es'} ` +
      `from previous WDA sessions. Cleaning them up`);
    try {
      await exec('kill', obsoletePids);
    } catch (e) {
      this.log.warn(`Failed to kill obsolete cached process${obsoletePids.length === 1 ? '' : 'es'} '${obsoletePids}'. ` +
        `Original error: ${e.message}`);
    }
  }

  /**
   * Return boolean if WDA is running or not
   * @return {Promise<boolean>} True if WDA is running
   * @throws {Error} If there was invalid response code or body
   */
  async isRunning () {
    return !!(await this.getStatus());
  }

  get basePath () {
    if (this.url.path === '/') {
      return '';
    }
    return this.url.path || '';
  }

  /**
   * Return current running WDA's status like below
   * {
   *   "state": "success",
   *   "os": {
   *     "name": "iOS",
   *     "version": "11.4",
   *     "sdkVersion": "11.3"
   *   },
   *   "ios": {
   *     "simulatorVersion": "11.4",
   *     "ip": "172.254.99.34"
   *   },
   *   "build": {
   *     "time": "Jun 24 2018 17:08:21",
   *     "productBundleIdentifier": "com.facebook.WebDriverAgentRunner"
   *   }
   * }
   *
   * @return {Promise<any?>} State Object
   * @throws {Error} If there was invalid response code or body
   */
  async getStatus () {
    const noSessionProxy = new NoSessionProxy({
      server: this.url.hostname,
      port: this.url.port,
      base: this.basePath,
      timeout: 3000,
    });
    try {
      return await noSessionProxy.command('/status', 'GET');
    } catch (err) {
      this.log.debug(`WDA is not listening at '${this.url.href}'`);
      return null;
    }
  }

  /**
   * Uninstall WDAs from the test device.
   * Over Xcode 11, multiple WDA can be in the device since Xcode 11 generates different WDA.
   * Appium does not expect multiple WDAs are running on a device.
   */
  async uninstall () {
    try {
      const bundleIds = await this.device.getUserInstalledBundleIdsByBundleName(WDA_CF_BUNDLE_NAME);
      if (_.isEmpty(bundleIds)) {
        this.log.debug('No WDAs on the device.');
        return;
      }

      this.log.debug(`Uninstalling WDAs: '${bundleIds}'`);
      for (const bundleId of bundleIds) {
        await this.device.removeApp(bundleId);
      }
    } catch (e) {
      this.log.debug(e);
      this.log.warn(`WebDriverAgent uninstall failed. Perhaps, it is already uninstalled? ` +
        `Original error: ${e.message}`);
    }
  }

  async _cleanupProjectIfFresh () {
    if (this.canSkipXcodebuild) {
      return;
    }

    const packageInfo = JSON.parse(await fs.readFile(path.join(BOOTSTRAP_PATH, 'package.json'), 'utf8'));
    const box = strongbox(packageInfo.name);
    let boxItem = box.getItem(RECENT_MODULE_VERSION_ITEM_NAME);
    if (!boxItem) {
      const timestampPath = path.resolve(process.env.HOME ?? '', WDA_UPGRADE_TIMESTAMP_PATH);
      if (await fs.exists(timestampPath)) {
        // TODO: It is probably a bit ugly to hardcode the recent version string,
        // TODO: hovewer it should do the job as a temporary transition trick
        // TODO: to switch from a hardcoded file path to the strongbox usage.
        try {
          boxItem = await box.createItemWithValue(RECENT_MODULE_VERSION_ITEM_NAME, '5.0.0');
        } catch (e) {
          this.log.warn(`The actual module version cannot be persisted: ${e.message}`);
          return;
        }
      } else {
        this.log.info('There is no need to perform the project cleanup. A fresh install has been detected');
        try {
          await box.createItemWithValue(RECENT_MODULE_VERSION_ITEM_NAME, packageInfo.version);
        } catch (e) {
          this.log.warn(`The actual module version cannot be persisted: ${e.message}`);
        }
        return;
      }
    }

    let recentModuleVersion = await boxItem.read();
    try {
      recentModuleVersion = util.coerceVersion(recentModuleVersion, true);
    } catch (e) {
      this.log.warn(`The persisted module version string has been damaged: ${e.message}`);
      this.log.info(`Updating it to '${packageInfo.version}' assuming the project clenup is not needed`);
      await boxItem.write(packageInfo.version);
      return;
    }

    if (util.compareVersions(recentModuleVersion, '>=', packageInfo.version)) {
      this.log.info(
        `WebDriverAgent does not need a cleanup. The project sources are up to date ` +
        `(${recentModuleVersion} >= ${packageInfo.version})`
      );
      return;
    }

    this.log.info(
      `Cleaning up the WebDriverAgent project after the module upgrade has happened ` +
      `(${recentModuleVersion} < ${packageInfo.version})`
    );
    try {
      // @ts-ignore xcodebuild should be set
      await this.xcodebuild.cleanProject();
      await boxItem.write(packageInfo.version);
    } catch (e) {
      this.log.warn(`Cannot perform WebDriverAgent project cleanup. Original error: ${e.message}`);
    }
  }

  /**
   * Launch WDA with preinstalled package without xcodebuild.
   * @param {string} sessionId Launch WDA and establish the session with this sessionId
   * @return {Promise<any?>} State Object
   */
  async launchWithPreinstalledWDA(sessionId) {
    const xctestEnv = {
      USE_PORT: this.wdaLocalPort || WDA_AGENT_PORT,
      WDA_PRODUCT_BUNDLE_IDENTIFIER: this.bundleIdForXctest
    };
    if (this.mjpegServerPort) {
      xctestEnv.MJPEG_SERVER_PORT = this.mjpegServerPort;
    }
    this.log.info('Launching WebDriverAgent on the device without xcodebuild');
    this.xctestApiClient = new Xctest(this.device.udid, this.bundleIdForXctest, null, {env: xctestEnv});

    await this.xctestApiClient.start();

    this.setupProxies(sessionId);
    const status = await this.getStatus();
    this.started = true;
    return status;
  }

  /**
   * Return current running WDA's status like below after launching WDA
   * {
   *   "state": "success",
   *   "os": {
   *     "name": "iOS",
   *     "version": "11.4",
   *     "sdkVersion": "11.3"
   *   },
   *   "ios": {
   *     "simulatorVersion": "11.4",
   *     "ip": "172.254.99.34"
   *   },
   *   "build": {
   *     "time": "Jun 24 2018 17:08:21",
   *     "productBundleIdentifier": "com.facebook.WebDriverAgentRunner"
   *   }
   * }
   *
   * @param {string} sessionId Launch WDA and establish the session with this sessionId
   * @return {Promise<any?>} State Object
   * @throws {Error} If there was invalid response code or body
   */
  async launch (sessionId) {
    if (this.webDriverAgentUrl) {
      this.log.info(`Using provided WebdriverAgent at '${this.webDriverAgentUrl}'`);
      this.url = this.webDriverAgentUrl;
      this.setupProxies(sessionId);
      return await this.getStatus();
    }

    if (this.usePreinstalledWDA) {
      if (this.isRealDevice) {
        return await this.launchWithPreinstalledWDA(sessionId);
      }
      throw new Error('usePreinstalledWDA is available only for a real device.');
    }

    this.log.info('Launching WebDriverAgent on the device');

    this.setupProxies(sessionId);

    if (!this.useXctestrunFile && !await fs.exists(this.agentPath)) {
      throw new Error(`Trying to use WebDriverAgent project at '${this.agentPath}' but the ` +
                      'file does not exist');
    }

    // useXctestrunFile and usePrebuiltWDA use existing dependencies
    // It depends on user side
    if (this.idb || this.useXctestrunFile || (this.derivedDataPath && this.usePrebuiltWDA)) {
      this.log.info('Skipped WDA project cleanup according to the provided capabilities');
    } else {
      const synchronizationKey = path.normalize(this.bootstrapPath);
      await SHARED_RESOURCES_GUARD.acquire(synchronizationKey,
        async () => await this._cleanupProjectIfFresh());
    }

    // We need to provide WDA local port, because it might be occupied
    await resetTestProcesses(this.device.udid, !this.isRealDevice);

    if (this.idb) {
      return await this.startWithIDB();
    }

    // @ts-ignore xcodebuild should be set
    await this.xcodebuild.init(this.noSessionProxy);

    // Start the xcodebuild process
    if (this.prebuildWDA) {
      // @ts-ignore xcodebuild should be set
      await this.xcodebuild.prebuild();
    }
    // @ts-ignore xcodebuild should be set
    return await this.xcodebuild.start();
  }

  async startWithIDB () {
    this.log.info('Will launch WDA with idb instead of xcodebuild since the corresponding flag is enabled');
    const {wdaBundleId, testBundleId} = await this.prepareWDA();
    const env = {
      USE_PORT: this.wdaRemotePort,
      WDA_PRODUCT_BUNDLE_IDENTIFIER: this.updatedWDABundleId,
    };
    if (this.mjpegServerPort) {
      env.MJPEG_SERVER_PORT = this.mjpegServerPort;
    }

    return await this.idb.runXCUITest(wdaBundleId, wdaBundleId, testBundleId, {env});
  }

  async parseBundleId (wdaBundlePath) {
    const infoPlistPath = path.join(wdaBundlePath, 'Info.plist');
    const infoPlist = await plist.parsePlist(await fs.readFile(infoPlistPath));
    if (!infoPlist.CFBundleIdentifier) {
      throw new Error(`Could not find bundle id in '${infoPlistPath}'`);
    }
    return infoPlist.CFBundleIdentifier;
  }

  async prepareWDA () {
    const wdaBundlePath = this.wdaBundlePath || await this.fetchWDABundle();
    const wdaBundleId = await this.parseBundleId(wdaBundlePath);
    if (!await this.device.isAppInstalled(wdaBundleId)) {
      await this.device.installApp(wdaBundlePath);
    }
    const testBundleId = await this.idb.installXCTestBundle(path.join(wdaBundlePath, 'PlugIns', 'WebDriverAgentRunner.xctest'));
    return {wdaBundleId, testBundleId, wdaBundlePath};
  }

  async fetchWDABundle () {
    if (!this.derivedDataPath) {
      return await bundleWDASim(this.xcodebuild);
    }
    const wdaBundlePaths = await fs.glob(`${this.derivedDataPath}/**/*${WDA_RUNNER_APP}/`, {
      absolute: true,
    });
    if (_.isEmpty(wdaBundlePaths)) {
      throw new Error(`Could not find the WDA bundle in '${this.derivedDataPath}'`);
    }
    return wdaBundlePaths[0];
  }

  async isSourceFresh () {
    const existsPromises = [
      'Resources',
      `Resources${path.sep}WebDriverAgent.bundle`,
    ].map((subPath) => fs.exists(path.resolve(this.bootstrapPath, subPath)));
    return (await B.all(existsPromises)).some((v) => v === false);
  }

  setupProxies (sessionId) {
    const proxyOpts = {
      log: this.log,
      server: this.url.hostname,
      port: this.url.port,
      base: this.basePath,
      timeout: this.wdaConnectionTimeout,
      keepAlive: true,
    };

    this.jwproxy = new JWProxy(proxyOpts);
    this.jwproxy.sessionId = sessionId;
    this.proxyReqRes = this.jwproxy.proxyReqRes.bind(this.jwproxy);

    this.noSessionProxy = new NoSessionProxy(proxyOpts);
  }

  async quit () {
    if (this.usePreinstalledWDA) {
      if (this.xctestApiClient) {
        this.log.info('Stopping the XCTest session');
        this.xctestApiClient.stop();
        this.xctestApiClient = null;
      }
    } else if (!this.args.webDriverAgentUrl) {
      this.log.info('Shutting down sub-processes');
      await this.xcodebuild?.quit();
      await this.xcodebuild?.reset();
    } else {
      this.log.debug('Do not stop xcodebuild nor XCTest session ' +
        'since the WDA session is managed by outside this driver.');
    }

    if (this.jwproxy) {
      this.jwproxy.sessionId = null;
    }

    this.started = false;

    if (!this.args.webDriverAgentUrl) {
      // if we populated the url ourselves (during `setupCaching` call, for instance)
      // then clean that up. If the url was supplied, we want to keep it
      this.webDriverAgentUrl = null;
    }
  }

  get url () {
    if (!this._url) {
      if (this.webDriverAgentUrl) {
        this._url = url.parse(this.webDriverAgentUrl);
      } else {
        const port = this.wdaLocalPort || WDA_AGENT_PORT;
        const {protocol, hostname} = url.parse(this.wdaBaseUrl || WDA_BASE_URL);
        this._url = url.parse(`${protocol}//${hostname}:${port}`);
      }
    }
    return this._url;
  }

  set url (_url) {
    this._url = url.parse(_url);
  }

  get fullyStarted () {
    return this.started;
  }

  set fullyStarted (started) {
    this.started = started ?? false;
  }

  async retrieveDerivedDataPath () {
    if (this.canSkipXcodebuild) {
      return;
    }
    // @ts-ignore xcodebuild should be set
    return await this.xcodebuild.retrieveDerivedDataPath();
  }

  /**
   * Reuse running WDA if it has the same bundle id with updatedWDABundleId.
   * Or reuse it if it has the default id without updatedWDABundleId.
   * Uninstall it if the method faces an exception for the above situation.
   */
  async setupCaching () {
    const status = await this.getStatus();
    if (!status || !status.build) {
      this.log.debug('WDA is currently not running. There is nothing to cache');
      return;
    }

    const {
      productBundleIdentifier,
      upgradedAt,
    } = status.build;
    // for real device
    if (util.hasValue(productBundleIdentifier) && util.hasValue(this.updatedWDABundleId) && this.updatedWDABundleId !== productBundleIdentifier) {
      this.log.info(`Will uninstall running WDA since it has different bundle id. The actual value is '${productBundleIdentifier}'.`);
      return await this.uninstall();
    }
    // for simulator
    if (util.hasValue(productBundleIdentifier) && !util.hasValue(this.updatedWDABundleId) && WDA_RUNNER_BUNDLE_ID !== productBundleIdentifier) {
      this.log.info(`Will uninstall running WDA since its bundle id is not equal to the default value ${WDA_RUNNER_BUNDLE_ID}`);
      return await this.uninstall();
    }

    const actualUpgradeTimestamp = await getWDAUpgradeTimestamp();
    this.log.debug(`Upgrade timestamp of the currently bundled WDA: ${actualUpgradeTimestamp}`);
    this.log.debug(`Upgrade timestamp of the WDA on the device: ${upgradedAt}`);
    if (actualUpgradeTimestamp && upgradedAt && _.toLower(`${actualUpgradeTimestamp}`) !== _.toLower(`${upgradedAt}`)) {
      this.log.info('Will uninstall running WDA since it has different version in comparison to the one ' +
        `which is bundled with appium-xcuitest-driver module (${actualUpgradeTimestamp} != ${upgradedAt})`);
      return await this.uninstall();
    }

    const message = util.hasValue(productBundleIdentifier)
      ? `Will reuse previously cached WDA instance at '${this.url.href}' with '${productBundleIdentifier}'`
      : `Will reuse previously cached WDA instance at '${this.url.href}'`;
    this.log.info(`${message}. Set the wdaLocalPort capability to a value different from ${this.url.port} if this is an undesired behavior.`);
    this.webDriverAgentUrl = this.url.href;
  }

  /**
   * Quit and uninstall running WDA.
   */
  async quitAndUninstall () {
    await this.quit();
    await this.uninstall();
  }
}

export default WebDriverAgent;
export { WebDriverAgent };
