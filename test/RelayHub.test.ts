import { balance, ether, expectEvent, expectRevert } from '@openzeppelin/test-helpers'
import BN from 'bn.js'
import { expect } from 'chai'

import { decodeRevertReason, getEip712Signature, removeHexPrefix } from '../src/common/Utils'
import RelayRequest, { cloneRelayRequest } from '../src/common/EIP712/RelayRequest'
import { getTestingEnvironment } from './TestUtils'
import { isRsk, Environment } from '../src/common/Environments'
import TypedRequestData, { GsnRequestType, getDomainSeparatorHash } from '../src/common/EIP712/TypedRequestData'
// @ts-ignore
import {TypedDataUtils} from 'eth-sig-util'
import { bufferToHex} from 'ethereumjs-util'

import {
  RelayHubInstance,
  PenalizerInstance,
  StakeManagerInstance,
  TestRecipientInstance,
  ForwarderInstance,
  TestPaymasterEverythingAcceptedInstance,
  TestPaymasterConfigurableMisbehaviorInstance,
  TestTokenInstance,
  ProxyFactoryInstance
} from '../types/truffle-contracts'
import { deployHub, encodeRevertReason } from './TestUtils'
import { chain } from 'lodash'

const StakeManager = artifacts.require('StakeManager')
const Forwarder = artifacts.require('Forwarder')
const Penalizer = artifacts.require('Penalizer')
const TestPaymasterEverythingAccepted = artifacts.require('TestPaymasterEverythingAccepted')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterStoreContext = artifacts.require('TestPaymasterStoreContext')
const TestPaymasterConfigurableMisbehavior = artifacts.require('TestPaymasterConfigurableMisbehavior')
const TestToken = artifacts.require('TestToken')
const ProxyFactory = artifacts.require('ProxyFactory')


contract('RelayHub', function ([_, relayOwner, relayManager, relayWorker, senderAddress, other, dest, incorrectWorker]) { // eslint-disable-line no-unused-vars
  const RelayCallStatusCodes = {
    OK: new BN('0'),
    RelayedCallFailed: new BN('1'),
    RejectedByPreRelayed: new BN('2'),
    RejectedByForwarder: new BN('3'),
    RejectedByRecipientRevert: new BN('4'),
    PostRelayedFailed: new BN('5'),
    PaymasterBalanceChanged: new BN('6'),
    RelayedTokenPaymentFailed : new BN('7')
  }

  let chainId: number
  let relayHub: string
  let stakeManager: StakeManagerInstance
  let penalizer: PenalizerInstance
  let relayHubInstance: RelayHubInstance
  let recipientContract: TestRecipientInstance
  let paymasterContract: TestPaymasterEverythingAcceptedInstance
  let forwarderInstance: ForwarderInstance
  let tokenContract: TestTokenInstance
  let factory : ProxyFactoryInstance //Creator of Smart Wallets
  let target: string
  let paymaster: string
  let forwarder: string
  let tokenAddress: string

  let env: Environment

 

  beforeEach(async function () {
    env = await getTestingEnvironment()
    stakeManager = await StakeManager.new()
    penalizer = await Penalizer.new()
    relayHubInstance = await deployHub(stakeManager.address, penalizer.address, env)
    paymasterContract = await TestPaymasterEverythingAccepted.new()
    forwarderInstance = await Forwarder.new()
    chainId = env.chainId
    tokenContract = await TestToken.new()
    forwarder = forwarderInstance.address

    // register hub's RelayRequest with forwarder, if not already done.
    await forwarderInstance.registerRequestType(
      GsnRequestType.typeName,
      GsnRequestType.typeSuffix
    )

    /////
    factory = await ProxyFactory.new(forwarderInstance.address)

    await factory.registerRequestType(
      GsnRequestType.typeName,
      GsnRequestType.typeSuffix
   )

    const logicAddress = '0x0000000000000000000000000000000000000000';
    const initParams = '0x';
    const reqParamCount = 11;
    const rReq={
      request:{
        to: '0x0000000000000000000000000000000000000000',
        data: '0x',
        from: senderAddress,
        nonce: '0',
        value: '0',
        gas: '400000',
        tokenRecipient: '0x0000000000000000000000000000000000000000',
        tokenContract: '0x0000000000000000000000000000000000000000',
        paybackTokens: '0',
        tokenGas: '400000',
        isDeploy: true
      },
      relayData:{
        gasPrice:'10',
        pctRelayFee:'10',
        baseRelayFee:'10000',
        relayWorker: relayWorker,
        paymaster:paymasterContract.address,
        forwarder: forwarderInstance.address,
        paymasterData:'0x',
        clientId:'1'
      }
    }

    const createdataToSign = new TypedRequestData(
      chainId,
      factory.address,
      rReq
    )

    const deploySignature = await getEip712Signature(
      web3,
      createdataToSign
    )

    const FORWARDER_PARAMS = "address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data,address tokenRecipient,address tokenContract,uint256 paybackTokens,uint256 tokenGas,bool isDeploy";
    const typeName = `${GsnRequestType.typeName}(${FORWARDER_PARAMS},${GsnRequestType.typeSuffix}`
    const typeHash = web3.utils.keccak256(typeName)

    const encoded = TypedDataUtils.encodeData(createdataToSign.primaryType, createdataToSign.message, createdataToSign.types);
    let suffixData = bufferToHex(encoded.slice((1 + reqParamCount) * 32))

    let a = await factory.relayedUserSmartWalletCreation(rReq.request, getDomainSeparatorHash(factory.address,chainId), typeHash,suffixData,deploySignature);
    const fwdAddress = await factory.getSmartWalletAddress(senderAddress, logicAddress, initParams)
    forwarder = fwdAddress
    
    recipientContract = await TestRecipient.new(forwarder)
    await tokenContract.mint('1000', forwarder)
    const fwd:ForwarderInstance = await Forwarder.at(fwdAddress);
    await fwd.registerRequestType(
      GsnRequestType.typeName,
      GsnRequestType.typeSuffix
   )
    forwarderInstance = fwd;
    target = recipientContract.address
    paymaster = paymasterContract.address
    relayHub = relayHubInstance.address
    tokenAddress = tokenContract.address
    


    await paymasterContract.setTrustedForwarder(forwarder)
    await paymasterContract.setRelayHub(relayHub)
  })

  it('should retrieve version number', async function () {
    const version = await relayHubInstance.versionHub()
    assert.match(version, /2\.\d*\.\d*-?.*\+opengsn\.hub\.irelayhub/)
  })
  describe('balances', function () {
    async function testDeposit (sender: string, paymaster: string, amount: BN): Promise<void> {
      const senderBalanceTracker = await balance.tracker(sender)
      const relayHubBalanceTracker = await balance.tracker(relayHub)

      // TODO review gas price for RSK
      const { logs } = await relayHubInstance.depositFor(paymaster, {
        from: sender,
        value: amount,
        gasPrice: 1 //0
      })
      expectEvent.inLogs(logs, 'Deposited', {
        paymaster,
        from: sender,
        amount
      })

      expect(await relayHubInstance.balanceOf(paymaster)).to.be.bignumber.equal(amount)

      if (isRsk(env)) {
        expect(await senderBalanceTracker.delta()).to.be.bignumber.closeTo(amount.neg(), new BN(50_000))
      } else {
        expect(await senderBalanceTracker.delta()).to.be.bignumber.equal(amount.neg())
      }
      
      expect(await relayHubBalanceTracker.delta()).to.be.bignumber.equal(amount)
    }

    it('can deposit for self', async function () {
      await testDeposit(other, other, ether('1'))
    })

    it('can deposit for others', async function () {
      await testDeposit(other, target, ether('1'))
    })

    // TODO review gasPrice for RSK
    it('cannot deposit amounts larger than the limit', async function () {
      await expectRevert.unspecified(
        relayHubInstance.depositFor(target, {
          from: other,
          value: ether('3'),
          gasPrice: 1 //0
        }),
        'deposit too big'
      )
    })

    // TODO review gasPrice for RSK
    it('can deposit multiple times and have a total deposit larger than the limit', async function () {
      await relayHubInstance.depositFor(target, {
        from: other,
        value: ether('1'),
        gasPrice: 1 //0
      })
      await relayHubInstance.depositFor(target, {
        from: other,
        value: ether('1'),
        gasPrice: 1 //0
      })
      await relayHubInstance.depositFor(target, {
        from: other,
        value: ether('1'),
        gasPrice: 1 //0
      })

      expect(await relayHubInstance.balanceOf(target)).to.be.bignumber.equals(ether('3'))
    })

    it('accounts with deposits can withdraw partially', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      const { logs } = await relayHubInstance.withdraw(amount.divn(2), dest, { from: other })
      expectEvent.inLogs(logs, 'Withdrawn', {
        account: other,
        dest,
        amount: amount.divn(2)
      })
    })

    it('accounts with deposits can withdraw all their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      const { logs } = await relayHubInstance.withdraw(amount, dest, { from: other })
      expectEvent.inLogs(logs, 'Withdrawn', {
        account: other,
        dest,
        amount
      })
    })

    it('accounts cannot withdraw more than their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      await expectRevert.unspecified(relayHubInstance.withdraw(amount.addn(1), dest, { from: other }), 'insufficient funds')
    })
  })

  describe('relayCall', function () {
    const baseRelayFee = '10000'
    const pctRelayFee = '10'
    const gasPrice = '10'
    const gasLimit = '1000000'
    const senderNonce = '0'
    let sharedRelayRequestData: RelayRequest
    const paymasterData = '0x'
    const clientId = '1'
    const tokensPaid = 1

    beforeEach(function () {
      sharedRelayRequestData = {
        request: {
          to: target,
          data: '',
          from: senderAddress,
          nonce: senderNonce,
          value: '0',
          gas: gasLimit,
          tokenRecipient: target,
          tokenContract: tokenAddress,
          paybackTokens: tokensPaid.toString(),
          tokenGas: gasLimit,
          isDeploy: false
        },
        relayData: {
          pctRelayFee,
          baseRelayFee,
          gasPrice,
          relayWorker,
          forwarder,
          paymaster,
          paymasterData,
          clientId
        }
      }
    })

    // TODO review gasPrice for RSK
    context('with unknown worker', function () {
      const signature = '0xdeadbeef'
      const approvalData = '0x'
      const gas = 4e6
      let relayRequest: RelayRequest
      beforeEach(async function () {
        relayRequest = cloneRelayRequest(sharedRelayRequestData)
        relayRequest.request.data = '0xdeadbeef'
        await relayHubInstance.depositFor(paymaster, {
          from: other,
          value: ether('1'),
          gasPrice: 1 //0
        })
      })

      it('should not accept a relay call', async function () {
        await expectRevert.unspecified(
          relayHubInstance.relayCall(10e6, relayRequest, signature, approvalData, gas, {
            from: relayWorker,
            gas
          }),
          'Unknown relay worker')
      })

      context('with manager stake unlocked', function () {
        beforeEach(async function () {
          await stakeManager.stakeForAddress(relayManager, 1000, {
            value: ether('1'),
            from: relayOwner
          })
          await stakeManager.authorizeHubByOwner(relayManager, relayHub, { from: relayOwner })
          await relayHubInstance.addRelayWorkers([relayWorker], {
            from: relayManager
          })
          await stakeManager.unauthorizeHubByOwner(relayManager, relayHub, { from: relayOwner })
        })
        it('should not accept a relay call', async function () {
          await expectRevert.unspecified(
            relayHubInstance.relayCall(10e6, relayRequest, signature, approvalData, gas, {
              from: relayWorker,
              gas
            }),
            'relay manager not staked')
        })
      })
    })

    context('with staked and registered relay', function () {
      const url = 'http://relay.com'
      const message = 'GSN RelayHub'
      const messageWithNoParams = 'Method with no parameters'

      let relayRequest: RelayRequest
      let encodedFunction: string
      let signatureWithPermissivePaymaster: string

      beforeEach(async function () {
        await stakeManager.stakeForAddress(relayManager, 1000, {
          value: ether('2'),
          from: relayOwner
        })
        await stakeManager.authorizeHubByOwner(relayManager, relayHub, { from: relayOwner })

        // truffle-contract doesn't let us create method data from the class, we need an actual instance
        encodedFunction = recipientContract.contract.methods.emitMessage(message).encodeABI()

        await relayHubInstance.addRelayWorkers([relayWorker], { from: relayManager })
        await relayHubInstance.registerRelayServer(baseRelayFee, pctRelayFee, url, { from: relayManager })
        relayRequest = cloneRelayRequest(sharedRelayRequestData)
        relayRequest.request.data = encodedFunction
        const dataToSign = new TypedRequestData(
          chainId,
          forwarder,
          relayRequest
        )
        signatureWithPermissivePaymaster = await getEip712Signature(
          web3,
          dataToSign
        )
        console.log(`SIGNATURE IS: ${signatureWithPermissivePaymaster}`);

        await relayHubInstance.depositFor(paymaster, {
          value: ether('1'),
          from: other
        })
      })

      context('with relay worker that is not externally-owned account', function () {
        it('should not accept relay requests', async function () {
          const signature = '0xdeadbeef'
          const gas = 4e6
          const TestRelayWorkerContract = artifacts.require('TestRelayWorkerContract')
          const testRelayWorkerContract = await TestRelayWorkerContract.new()
          await relayHubInstance.addRelayWorkers([testRelayWorkerContract.address], {
            from: relayManager
          })
          await expectRevert.unspecified(
            testRelayWorkerContract.relayCall(
              relayHubInstance.address,
              10e6,
              relayRequest,
              signature,
              gas,
              {
                gas
              }),
            'relay worker cannot be a smart contract')
            const tknBalance = await tokenContract.balanceOf(target)
            assert.isTrue(new BN(0).eq(tknBalance))
        })
      })
      context('with view functions only', function () {
        let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance
        let relayRequestMisbehavingPaymaster: RelayRequest

        beforeEach(async function () {
          misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
          await misbehavingPaymaster.setTrustedForwarder(forwarder)
          await misbehavingPaymaster.setRelayHub(relayHub)
          await relayHubInstance.depositFor(misbehavingPaymaster.address, {
            value: ether('1'),
            from: other
          })
          relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
          relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address
        })

        // TODO re-enable
        it.skip('should get \'paymasterAccepted = true\' and no revert reason as view call result of \'relayCall\' for a valid transaction', async function () {
          const relayCallView = await relayHubInstance.contract.methods.relayCall(
            10e6,
            relayRequest,
            signatureWithPermissivePaymaster, '0x', 7e6)
            .call({
              from: relayWorker,
              gas: 7e6
            })
          assert.equal(relayCallView.returnValue, null)
          assert.equal(relayCallView.paymasterAccepted, true)
        })

        //TODO re-enable
        it.skip('should get Paymaster\'s reject reason from view call result of \'relayCall\' for a transaction with a wrong signature', async function () {
          await misbehavingPaymaster.setReturnInvalidErrorCode(true)
          const relayCallView =
            await relayHubInstance.contract.methods
              .relayCall(10e6, relayRequestMisbehavingPaymaster, '0x', '0x', 7e6)
              .call({ from: relayWorker })

          assert.equal(relayCallView.paymasterAccepted, false)

          assert.equal(relayCallView.returnValue, encodeRevertReason('invalid code'))
          assert.equal(decodeRevertReason(relayCallView.returnValue), 'invalid code')
        })
      })

      context('with funded paymaster', function () {
        let signature

        let paymasterWithContext
        let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance

        let relayRequestPaymasterWithContext: RelayRequest
        let signatureWithContextPaymaster: string

        let signatureWithMisbehavingPaymaster: string
        let relayRequestMisbehavingPaymaster: RelayRequest
        const gas = 4e6

        beforeEach(async function () {
          paymasterWithContext = await TestPaymasterStoreContext.new()
          misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
          await paymasterWithContext.setTrustedForwarder(forwarder)
          await misbehavingPaymaster.setTrustedForwarder(forwarder)
          await paymasterWithContext.setRelayHub(relayHub)
          await misbehavingPaymaster.setRelayHub(relayHub)
          await relayHubInstance.depositFor(paymasterWithContext.address, {
            value: ether('1'),
            from: other
          })
          await relayHubInstance.depositFor(misbehavingPaymaster.address, {
            value: ether('1'),
            from: other
          })
          let dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequest
          )

          signature = await getEip712Signature(
            web3,
            dataToSign
          )

          relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
          relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address

          dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestMisbehavingPaymaster
          )
          signatureWithMisbehavingPaymaster = await getEip712Signature(
            web3,
            dataToSign
          )

          relayRequestPaymasterWithContext = cloneRelayRequest(relayRequest)
          relayRequestPaymasterWithContext.relayData.paymaster = paymasterWithContext.address
          dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestPaymasterWithContext
          )
          signatureWithContextPaymaster = await getEip712Signature(
            web3,
            dataToSign
          )
        })

        it('relayCall executes the transaction and increments sender nonce on hub', async function () {
          const nonceBefore = await forwarderInstance.getNonce()

          const { tx, logs } = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })

          const nonceAfter = await forwarderInstance.getNonce()
          // assert.equal(nonceBefore.addn(1).toNumber(), nonceAfter.toNumber())
          assert.equal(nonceBefore.addn(1).toNumber(), nonceAfter.toNumber()) //Each execution increment the nonce twice (tkn payment + call)
          
          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(tokensPaid).eq(tknBalance))
          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
            message,
            realSender: senderAddress,
            msgSender: forwarder,
            origin: relayWorker
          })

          const expectedReturnValue = web3.eth.abi.encodeParameter('string', 'emitMessage return value')
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.OK,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.OK
          })
        })

        it('relayCall should refuse to re-send transaction with same nonce', async function () {
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })
          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted')
          
          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(tokensPaid).eq(tknBalance))

          const ret = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })
          const afterTknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(tokensPaid).eq(afterTknBalance))

          await expectEvent(ret, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('nonce mismatch') })
        })
        // This test is added due to a regression that almost slipped to production.
        it('relayCall executes the transaction with no parameters', async function () {
          const encodedFunction = recipientContract.contract.methods.emitMessageNoParams().encodeABI()
          const relayRequestNoCallData = cloneRelayRequest(relayRequest)
          relayRequestNoCallData.request.data = encodedFunction
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestNoCallData
          )
          signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequestNoCallData, signature, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })

          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(tokensPaid).eq(tknBalance))

          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
            message: messageWithNoParams,
            realSender: senderAddress,
            msgSender: forwarder,
            origin: relayWorker
          })
        })

        it('relayCall executes a transaction even if recipient call reverts', async function () {
          const encodedFunction = recipientContract.contract.methods.testRevert().encodeABI()
          const relayRequestRevert = cloneRelayRequest(relayRequest)
          relayRequestRevert.request.data = encodedFunction
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestRevert
          )
          signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestRevert, signature, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })

          const expectedReturnValue = '0x08c379a0' + removeHexPrefix(web3.eth.abi.encodeParameter('string', 'always fail'))
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.RelayedCallFailed,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.RelayedCallFailed
          })

          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(tokensPaid).eq(tknBalance))
        })

        it('relayCall cant transfer more tokens than sender balance', async function () {
          const encodedFunction = recipientContract.contract.methods.testRevert().encodeABI()
          const relayRequestRevert = cloneRelayRequest(relayRequest)
          relayRequestRevert.request.data = encodedFunction
          relayRequestRevert.request.paybackTokens = '1001'
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestRevert
          )
          signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestRevert, signature, '0x', gas, {
            from: relayWorker,
            gas,
            gasPrice
          })

          const expectedReturnValue = '0x08c379a0' + removeHexPrefix(web3.eth.abi.encodeParameter('string', 'ERC20: transfer amount exceeds balance'))
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.RelayedTokenPaymentFailed,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.RelayedTokenPaymentFailed
          })

          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(0).eq(tknBalance))
        })


        it('postRelayedCall receives values returned in preRelayedCall', async function () {
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequestPaymasterWithContext,
            signatureWithContextPaymaster, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice
            })

          await expectEvent.inTransaction(tx, TestPaymasterStoreContext, 'SampleRecipientPostCallWithValues', {
            context: 'context passed from preRelayedCall to postRelayedCall'
          })
        })

        it('relaying is aborted if the paymaster reverts the preRelayedCall', async function () {
          await misbehavingPaymaster.setReturnInvalidErrorCode(true)
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice
            })

          expectEvent.inLogs(logs, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('invalid code') })
        })

        it('should not accept relay requests if gas limit is too low for a relayed transaction', async function () {
          // Adding gasReserve is not enough by a few wei as some gas is spent before gasleft().
          const gasReserve = 99999
          const gas = parseInt(gasLimit) + gasReserve
          await expectRevert.unspecified(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', gas, {
              from: relayWorker,
              gasPrice,
              gas
            }),
            'Not enough gas left for innerRelayCall to complete')
        })

        it('should not accept relay requests with gas price lower then user specified', async function () {
          await expectRevert.unspecified(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice: parseInt(gasPrice) - 1
            }),
            'Invalid gas price')
        })

        it('should not accept relay requests with gas limit higher then block gas limit', async function () {
          await expectRevert.unspecified(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', 100000001, {
              from: relayWorker,
              gasPrice,
              gas
            }),
            'Impossible gas limit')
        })

        it('should not accept relay requests with incorrect relay worker', async function () {
          await relayHubInstance.addRelayWorkers([incorrectWorker], { from: relayManager })
          await expectRevert.unspecified(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', gas, {
              from: incorrectWorker,
              gasPrice,
              gas
            }),
            'Not a right worker')
        })

        it('should not accept relay requests if destination recipient doesn\'t have a balance to pay for it',
          async function () {
            const paymaster2 = await TestPaymasterEverythingAccepted.new()
            await paymaster2.setTrustedForwarder(forwarder)
            await paymaster2.setRelayHub(relayHub)
            const maxPossibleCharge = (await relayHubInstance.calculateCharge(gasLimit, {
              gasPrice,
              pctRelayFee,
              baseRelayFee,
              relayWorker,
              forwarder,
              paymaster: paymaster2.address,
              paymasterData: '0x',
              clientId: '1'
            })).toNumber()
            await paymaster2.deposit({ value: (maxPossibleCharge - 1).toString() }) // TODO: replace with correct margin calculation

            const relayRequestPaymaster2 = cloneRelayRequest(relayRequest)
            relayRequestPaymaster2.relayData.paymaster = paymaster2.address

            await expectRevert.unspecified(
              relayHubInstance.relayCall(10e6, relayRequestPaymaster2, signatureWithMisbehavingPaymaster, '0x', gas, {
                from: relayWorker,
                gas,
                gasPrice
              }),
              'Paymaster balance too low')
          })

        it('should not execute the \'relayedCall\' if \'preRelayedCall\' reverts', async function () {
          await misbehavingPaymaster.setRevertPreRelayCall(true)
          // @ts-ignore (there is a problem with web3 types annotations that must be solved)
          const startBlock = await web3.eth.getBlockNumber()

          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice: gasPrice
            })

          // There should not be an event emitted, which means the result of 'relayCall' was indeed reverted
          const logsMessages = await recipientContract.contract.getPastEvents('SampleRecipientEmitted', {
            fromBlock: startBlock,
            toBlock: 'latest'
          })
          assert.equal(0, logsMessages.length)
          // const expectedReturnValue = '0x08c379a0' + removeHexPrefix(web3.eth.abi.encodeParameter('string', 'You asked me to revert, remember?'))
          expectEvent.inLogs(logs, 'TransactionRejectedByPaymaster', {
            reason: encodeRevertReason('You asked me to revert, remember?')
          })
        })

        it('should revert the \'relayedCall\' if \'postRelayedCall\' reverts', async function () {
          await misbehavingPaymaster.setRevertPostRelayCall(true)
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice: gasPrice
            })

          // @ts-ignore (there is a problem with web3 types annotations that must be solved)
          const startBlock = await web3.eth.getBlockNumber()
          // There should not be an event emitted, which means the result of 'relayCall' was indeed reverted
          const logsMessages = await recipientContract.contract.getPastEvents('SampleRecipientEmitted', {
            fromBlock: startBlock,
            toBlock: 'latest'
          })
          assert.equal(0, logsMessages.length)
          const tknBalance = await tokenContract.balanceOf(target)
          assert.isTrue(new BN(0).eq(tknBalance))
          expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.PostRelayedFailed })
        })

        describe('recipient balance withdrawal ban', function () {
          let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance
          let relayRequestMisbehavingPaymaster: RelayRequest
          let signature: string
          beforeEach(async function () {
            misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
            await misbehavingPaymaster.setTrustedForwarder(forwarder)
            await misbehavingPaymaster.setRelayHub(relayHub)
            await relayHubInstance.depositFor(misbehavingPaymaster.address, {
              value: ether('1'),
              from: other
            })

            relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
            relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address
            const dataToSign = new TypedRequestData(
              chainId,
              forwarder,
              relayRequestMisbehavingPaymaster
            )
            signature = await getEip712Signature(
              web3,
              dataToSign
            )
          })

          it('reverts relayed call if recipient withdraws balance during preRelayedCall', async function () {
            await misbehavingPaymaster.setWithdrawDuringPreRelayedCall(true)
            await assertRevertWithPaymasterBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during the relayed call', async function () {
            await recipientContract.setWithdrawDuringRelayedCall(misbehavingPaymaster.address)
            await assertRevertWithPaymasterBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during postRelayedCall', async function () {
            await misbehavingPaymaster.setWithdrawDuringPostRelayedCall(true)
            await assertRevertWithPaymasterBalanceChanged()
          })

          async function assertRevertWithPaymasterBalanceChanged (): Promise<void> {
            const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signature, '0x', gas, {
              from: relayWorker,
              gas,
              gasPrice
            })
            expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.PaymasterBalanceChanged })
          }
        })
      })
    })
  })
})
