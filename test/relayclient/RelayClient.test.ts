import Transaction from 'ethereumjs-tx/dist/transaction'
import Web3 from 'web3'
import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { HttpProvider } from 'web3-core'
import express from 'express'
import axios from 'axios'

import {
  RelayHubInstance,
  StakeManagerInstance,
  TestRecipientInstance,
  TestEnvelopingPaymasterInstance, SmartWalletInstance, ProxyFactoryInstance, TestTokenInstance
} from '../../types/truffle-contracts'

import RelayRequest from '../../src/common/EIP712/RelayRequest'
import { _dumpRelayingResult, RelayClient } from '../../src/relayclient/RelayClient'
import { Address } from '../../src/relayclient/types/Aliases'
import { PrefixedHexString } from 'ethereumjs-tx'
import { configureGSN, getDependencies, GSNConfig } from '../../src/relayclient/GSNConfigurator'
import replaceErrors from '../../src/common/ErrorReplacerJSON'
import GsnTransactionDetails from '../../src/relayclient/types/GsnTransactionDetails'

import BadHttpClient from '../dummies/BadHttpClient'
import BadContractInteractor from '../dummies/BadContractInteractor'
import BadRelayedTransactionValidator from '../dummies/BadRelayedTransactionValidator'
import { deployHub, startRelay, stopRelay, getTestingEnvironment, createProxyFactory, createSmartWallet } from '../TestUtils'
import { RelayInfo } from '../../src/relayclient/types/RelayInfo'
import PingResponse from '../../src/common/PingResponse'
import { GsnEvent } from '../../src/relayclient/GsnEvents'
import { Web3Provider } from '../../src/relayclient/ContractInteractor'
import bodyParser from 'body-parser'
import { Server } from 'http'
import HttpClient from '../../src/relayclient/HttpClient'
import HttpWrapper from '../../src/relayclient/HttpWrapper'
import { RelayTransactionRequest } from '../../src/relayclient/types/RelayTransactionRequest'

const StakeManager = artifacts.require('StakeManager')
const TestRecipient = artifacts.require('TestRecipient')
const TestEnvelopingPaymaster = artifacts.require('TestEnvelopingPaymaster')
const SmartWallet = artifacts.require('SmartWallet')
const TestToken = artifacts.require('TestToken')
const expect = chai.expect
chai.use(sinonChai)

const localhostOne = 'http://localhost:8090'
const underlyingProvider = web3.currentProvider as HttpProvider

class MockHttpClient extends HttpClient {
  constructor (readonly mockPort: number,
    httpWrapper: HttpWrapper, config: Partial<GSNConfig>) {
    super(httpWrapper, config)
  }

  async relayTransaction (relayUrl: string, request: RelayTransactionRequest): Promise<PrefixedHexString> {
    return await super.relayTransaction(this.mapUrl(relayUrl), request)
  }

  private mapUrl (relayUrl: string): string {
    return relayUrl.replace(':8090', `:${this.mockPort}`)
  }
}

function addr (n: number): string {
  return '0x' + n.toString().repeat(40)
}

contract('RelayClient', function (accounts) {
  let web3: Web3
  let relayHub: RelayHubInstance
  let stakeManager: StakeManagerInstance
  let testRecipient: TestRecipientInstance
  let paymaster: TestEnvelopingPaymasterInstance
  let relayProcess: ChildProcessWithoutNullStreams

  let relayClient: RelayClient
  let gsnConfig: Partial<GSNConfig>
  let options: GsnTransactionDetails
  let to: Address
  let from: Address
  let data: PrefixedHexString
  let gsnEvents: GsnEvent[] = []
  let factory: ProxyFactoryInstance
  let sWalletTemplate: SmartWalletInstance
  let smartWallet: SmartWalletInstance
  let token: TestTokenInstance

  before(async function () {
    web3 = new Web3(underlyingProvider)
    stakeManager = await StakeManager.new()
    relayHub = await deployHub(stakeManager.address)
    testRecipient = await TestRecipient.new()
    sWalletTemplate = await SmartWallet.new()
    token = await TestToken.new()
    const env = (await getTestingEnvironment())
    const senderAddress = accounts[0]
    factory = await createProxyFactory(sWalletTemplate)
    smartWallet = await createSmartWallet(senderAddress, factory, env.chainId)
    paymaster = await TestEnvelopingPaymaster.new()
    await paymaster.setRelayHub(relayHub.address)
    await paymaster.deposit({ value: web3.utils.toWei('1', 'ether') })

    relayProcess = await startRelay(relayHub.address, stakeManager, {
      stake: 1e18,
      relayOwner: accounts[1],
      ethereumNodeUrl: underlyingProvider.host
    })

    gsnConfig = {
      logLevel: 5,
      relayHubAddress: relayHub.address,
      chainId: env.chainId
    }
    relayClient = new RelayClient(underlyingProvider, gsnConfig)

    from = senderAddress
    to = testRecipient.address
    await token.mint('1000', smartWallet.address)

    data = testRecipient.contract.methods.emitMessage('hello world').encodeABI()

    options = {
      from,
      to,
      data,
      forwarder: smartWallet.address,
      paymaster: paymaster.address,
      paymasterData: '0x',
      clientId: '1',
      tokenRecipient: paymaster.address,
      tokenContract: token.address,
      tokenAmount: '1',
      factory: addr(0)
    }
  })

  after(async function () {
    await stopRelay(relayProcess)
  })

  describe('#relayTransaction()', function () {
    it('should send transaction to a relay and receive a signed transaction in response', async function () {
      const relayingResult = await relayClient.relayTransaction(options)
      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)

      // validate we've got the "SampleRecipientEmitted" event
      // TODO: use OZ test helpers
      const topic: string = web3.utils.sha3('SampleRecipientEmitted(string,address,address,uint256,uint256)') ?? ''
      assert(res.logs.find(log => log.topics.includes(topic)))

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())
    })

    it('should skip timed-out server', async function () {
      let server: Server | undefined
      try {
        const pingResponse = await axios.get('http://localhost:8090/getaddr').then(res => res.data)
        const mockServer = express()
        mockServer.use(bodyParser.urlencoded({ extended: false }))
        mockServer.use(bodyParser.json())

        mockServer.get('/getaddr', async (req, res) => {
          console.log('=== got GET ping', req.query)
          res.send(pingResponse)
        })
        mockServer.post('/relay', () => {
          console.log('== got relay.. ignoring')
          // don't answer... keeping client in limbo
        })

        await new Promise((resolve) => {
          server = mockServer.listen(0, resolve)
        })
        const mockServerPort = (server as any).address().port

        // MockHttpClient alter the server port, so the client "thinks" it works with relayUrl, but actually
        // it uses the mockServer's port
        const relayClient = new RelayClient(underlyingProvider, gsnConfig, {
          httpClient: new MockHttpClient(mockServerPort, new HttpWrapper({ timeout: 100 }), gsnConfig)
        })

        // async relayTransaction (relayUrl: string, request: RelayTransactionRequest): Promise<PrefixedHexString> {
        const relayingResult = await relayClient.relayTransaction(options)
        assert.match(_dumpRelayingResult(relayingResult), /timeout.*exceeded/)
      } finally {
        server?.close()
      }
    })

    it('should use forceGasPrice if provided', async function () {
      const forceGasPrice = '0x777777777'
      const optionsForceGas = Object.assign({}, options, { forceGasPrice })
      const { transaction, pingErrors, relayingErrors } = await relayClient.relayTransaction(optionsForceGas)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 0)
      assert.equal(parseInt(transaction!.gasPrice.toString('hex'), 16), parseInt(forceGasPrice))
    })

    it('should return errors encountered in ping', async function () {
      const badHttpClient = new BadHttpClient(configureGSN(gsnConfig), true, false, false)
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, { httpClient: badHttpClient })
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(relayingErrors.size, 0)
      assert.equal(pingErrors.size, 1)
      assert.equal(pingErrors.get(localhostOne)!.message, BadHttpClient.message)
    })

    it('should return errors encountered in relaying', async function () {
      const badHttpClient = new BadHttpClient(configureGSN(gsnConfig), false, true, false)
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, { httpClient: badHttpClient })
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.equal(relayingErrors.get(localhostOne)!.message, BadHttpClient.message)
    })

    it('should return errors in callback (asyncApprovalData) ', async function () {
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, {
          asyncApprovalData: async () => { throw new Error('approval-error') }
        })
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.match(relayingErrors.values().next().value.message, /approval-error/)
    })

    it('should return errors in callback (asyncPaymasterData) ', async function () {
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, {
          asyncPaymasterData: async () => { throw new Error('paymasterData-error') }
        })
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.match(relayingErrors.values().next().value.message, /paymasterData-error/)
    })

    it.skip('should return errors in callback (scoreCalculator) ', async function () {
      // can't be used: scoring is completely disabled
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, {
          scoreCalculator: async () => { throw new Error('score-error') }
        })
      const ret = await relayClient.relayTransaction(options)
      const { transaction, relayingErrors, pingErrors } = ret
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.match(relayingErrors.values().next().value.message, /score-error/)
    })

    // TODOO test other things, for example, if the smart wallet to deploy has no funds, etc
    // Do we want to restrict to certnain factories?

    it('should calculate the estimatedGas for deploying a SmartWallet using the ProxyFactory', async function () {
      const eoaWithoutSmartWallet = await web3.eth.personal.newAccount('pas2')
      await web3.eth.personal.unlockAccount(eoaWithoutSmartWallet, 'pas2')

      const details: GsnTransactionDetails = {
        from: eoaWithoutSmartWallet,
        to: addr(0), // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        forwarder: addr(0), // There's no forwarder in a deploy, field not read
        paymaster: paymaster.address,
        paymasterData: '0x',
        clientId: '1',
        tokenRecipient: paymaster.address,
        tokenContract: token.address,
        tokenAmount: '1',
        factory: factory.address, // Indicate to the RelayHub this is a Smart Wallet deploy
        useGSN: true
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWallet, details.to, details.data)
      await token.mint('1000', swAddress)

      const estimatedGasResult = await relayClient.calculateSmartWalletDeployGas(details)
      const cushion = 1000

      assert.isTrue(estimatedGasResult >= (155000 - cushion))

    })

    it('should send a SmartWallet create transaction to a relay and receive a signed transaction in response', async function () {
      const eoaWithoutSmartWallet = await web3.eth.personal.newAccount('eoaPass')
      await web3.eth.personal.unlockAccount(eoaWithoutSmartWallet, 'eoaPass')

      const deployOptions = {
        from: eoaWithoutSmartWallet,
        to: addr(0), // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        gas: '0x1E8480',
        forwarder: addr(0), // There's no forwarder in a deploy, field not read
        paymaster: paymaster.address,
        paymasterData: '0x',
        clientId: '1',
        tokenRecipient: paymaster.address,
        tokenContract: token.address,
        tokenAmount: '1',
        factory: factory.address // Indicate to the RelayHub this is a Smart Wallet deploy
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWallet, deployOptions.to, deployOptions.data)
      await token.mint('1000', swAddress)

      assert.equal(await web3.eth.getCode(swAddress), '0x00', 'SmartWallet not yet deployed, it must not have installed code')

      const relayingResult = await relayClient.relayTransaction(deployOptions)
      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)
      // validate we've got the "Deployed" event

      const topic: string = web3.utils.sha3('Deployed(address,uint256)') ?? ''
      assert.notEqual(topic, '', 'error while calculating topic')

      assert(res.logs.find(log => log.topics.includes(topic)))
      const eventIdx = res.logs.findIndex(log => log.topics.includes(topic))
      const loggedEvent = res.logs[eventIdx]
      const saltSha = web3.utils.soliditySha3(
        { t: 'address', v: eoaWithoutSmartWallet },
        { t: 'address', v: deployOptions.to },
        { t: 'bytes', v: deployOptions.data }
      ) ?? ''
      assert.notEqual(saltSha, '', 'error while calculating salt')

      const expectedSalt = web3.utils.toBN(saltSha).toString()

      const obtainedEvent = web3.eth.abi.decodeParameters([{ type: 'address', name: 'sWallet' },
        { type: 'uint256', name: 'salt' }], loggedEvent.data)

      assert.equal(obtainedEvent.salt, expectedSalt, 'salt from Deployed event is not the expected one')
      assert.equal(obtainedEvent.sWallet, swAddress, 'SmartWallet address from the Deployed event is not the expected one')

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())

      let expectedCode = await factory.getCreationBytecode()
      expectedCode = '0x' + expectedCode.slice(20, expectedCode.length)// only runtime code
      assert.equal(await web3.eth.getCode(swAddress), expectedCode, 'The installed code is not the expected one')
    })

    describe('with events listener', () => {
      function eventsHandler (e: GsnEvent): void {
        gsnEvents.push(e)
      }

      before('registerEventsListener', () => {
        relayClient = new RelayClient(underlyingProvider, gsnConfig)
        relayClient.registerEventListener(eventsHandler)
      })
      it('should call events handler', async function () {
        await relayClient.relayTransaction(options)
        assert.equal(gsnEvents.length, 8)
        assert.equal(gsnEvents[0].step, 1)
        assert.equal(gsnEvents[0].total, 8)
        assert.equal(gsnEvents[7].step, 8)
      })
      describe('removing events listener', () => {
        before('registerEventsListener', () => {
          gsnEvents = []
          relayClient.unregisterEventListener(eventsHandler)
        })
        it('should call events handler', async function () {
          await relayClient.relayTransaction(options)
          assert.equal(gsnEvents.length, 0)
        })
      })
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  describe('#_calculateDefaultGasPrice()', async function () {
    it('should use minimum gas price if calculated is to low', async function () {
      const minGasPrice = 1e18
      const gsnConfig: Partial<GSNConfig> = {
        logLevel: 5,
        relayHubAddress: relayHub.address,
        minGasPrice,
        chainId: (await getTestingEnvironment()).chainId
      }
      const relayClient = new RelayClient(underlyingProvider, gsnConfig)
      const calculatedGasPrice = await relayClient._calculateGasPrice()
      assert.equal(calculatedGasPrice, `0x${minGasPrice.toString(16)}`)
    })
  })

  describe('#_attemptRelay()', function () {
    const relayUrl = localhostOne
    const relayWorkerAddress = accounts[1]
    const relayManager = accounts[2]
    const relayOwner = accounts[3]
    let pingResponse: PingResponse
    let relayInfo: RelayInfo
    let optionsWithGas: GsnTransactionDetails

    before(async function () {
      await stakeManager.stakeForAddress(relayManager, 7 * 24 * 3600, {
        from: relayOwner,
        value: (2e18).toString()
      })
      await stakeManager.authorizeHubByOwner(relayManager, relayHub.address, { from: relayOwner })
      await relayHub.addRelayWorkers([relayWorkerAddress], { from: relayManager })
      await relayHub.registerRelayServer(2e16.toString(), '10', 'url', { from: relayManager })
      await relayHub.depositFor(paymaster.address, { value: (2e18).toString() })
      pingResponse = {
        relayWorkerAddress: relayWorkerAddress,
        relayManagerAddress: relayManager,
        relayHubAddress: relayManager,
        minGasPrice: '',
        maxAcceptanceBudget: 1e10.toString(),
        ready: true,
        version: ''
      }
      relayInfo = {
        relayInfo: {
          relayManager,
          relayUrl,
          baseRelayFee: '',
          pctRelayFee: ''
        },
        pingResponse
      }
      optionsWithGas = Object.assign({}, options, {
        gas: '0xf4240',
        gasPrice: '0x51f4d5c00'
      })
    })

    it('should return error if view call to \'relayCall()\' fails', async function () {
      const badContractInteractor = new BadContractInteractor(web3.currentProvider as Web3Provider, configureGSN(gsnConfig), true)
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, { contractInteractor: badContractInteractor })
      await relayClient._init()
      const { transaction, error } = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.isUndefined(transaction)
      assert.equal(error!.message, `local view call to 'relayCall()' reverted: ${BadContractInteractor.message}`)
    })

    it('should report relays that timeout to the Known Relays Manager', async function () {
      const badHttpClient = new BadHttpClient(configureGSN(gsnConfig), false, false, true)
      const dependencyTree = getDependencies(configureGSN(gsnConfig), underlyingProvider, { httpClient: badHttpClient })
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, dependencyTree)
      await relayClient._init()

      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      const attempt = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.equal(attempt.error?.message, 'some error describing how timeout occurred somewhere')
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.been.calledWith(sinon.match.any, relayManager, relayUrl)
    })

    it('should not report relays if error is not timeout', async function () {
      const badHttpClient = new BadHttpClient(configureGSN(gsnConfig), false, true, false)
      const dependencyTree = getDependencies(configureGSN(gsnConfig), underlyingProvider, { httpClient: badHttpClient })
      dependencyTree.httpClient = badHttpClient
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, dependencyTree)
      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      await relayClient._attemptRelay(relayInfo, optionsWithGas)
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.not.been.called
    })

    it('should return error if transaction returned by a relay does not pass validation', async function () {
      const badHttpClient = new BadHttpClient(configureGSN(gsnConfig), false, false, false, pingResponse, '0x123')
      let dependencyTree = getDependencies(configureGSN(gsnConfig), underlyingProvider)
      const badTransactionValidator = new BadRelayedTransactionValidator(true, dependencyTree.contractInteractor, configureGSN(gsnConfig))
      dependencyTree = getDependencies(configureGSN(gsnConfig), underlyingProvider, {
        httpClient: badHttpClient,
        transactionValidator: badTransactionValidator
      })
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, dependencyTree)

      await relayClient._init()
      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      const { transaction, error } = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.isUndefined(transaction)
      assert.equal(error!.message, 'Returned transaction did not pass validation')
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.been.calledWith(sinon.match.any, relayManager, relayUrl)
    })

    describe('#_prepareRelayHttpRequest()', function () {
      const asyncApprovalData = async function (_: RelayRequest): Promise<PrefixedHexString> {
        return await Promise.resolve('0x1234567890')
      }
      const asyncPaymasterData = async function (_: RelayRequest): Promise<PrefixedHexString> {
        return await Promise.resolve('0xabcd')
      }

      it('should use provided approval function', async function () {
        const relayClient =
          new RelayClient(underlyingProvider, gsnConfig, {
            asyncApprovalData,
            asyncPaymasterData
          })
        const httpRequest = await relayClient._prepareRelayHttpRequest(relayInfo, optionsWithGas)
        assert.equal(httpRequest.metadata.approvalData, '0x1234567890')
        assert.equal(httpRequest.relayRequest.relayData.paymasterData, '0xabcd')
      })
    })
  })

  describe('#_broadcastRawTx()', function () {
    // TODO: TBD: there has to be other behavior then that. Maybe query the transaction with the nonce somehow?
    it('should return \'wrongNonce\' if broadcast fails with nonce error', async function () {
      const badContractInteractor = new BadContractInteractor(underlyingProvider, configureGSN(gsnConfig), true)
      const transaction = new Transaction('0x')
      const relayClient =
        new RelayClient(underlyingProvider, gsnConfig, { contractInteractor: badContractInteractor })
      const { hasReceipt, wrongNonce, broadcastError } = await relayClient._broadcastRawTx(transaction)
      assert.isFalse(hasReceipt)
      assert.isTrue(wrongNonce)
      assert.equal(broadcastError?.message, BadContractInteractor.wrongNonceMessage)
    })
  })
})
