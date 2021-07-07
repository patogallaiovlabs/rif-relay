import { Address, BoolString } from '../relayclient/types/Aliases'
import { PrefixedHexString } from 'ethereumjs-tx'
import { ethers } from 'ethers'

export interface CommitmentReceipt {
  commitment: Commitment
  workerSignature: PrefixedHexString
  workerAddress: Address
}

export interface CommitmentResponse {
  signedTx: PrefixedHexString
  signedReceipt?: CommitmentReceipt
  transactionHash: PrefixedHexString
}

export class Commitment {
  time: Number
  from: Address
  to: Address
  data: PrefixedHexString
  relayHubAddress: Address
  relayWorker: Address
  enabledQos: BoolString
  signature: PrefixedHexString

  constructor (
    time: Number,
    from: Address,
    to: Address,
    data: PrefixedHexString,
    relayHubAddress: Address,
    relayWorker: Address,
    enabledQos: BoolString | undefined,
    signature: PrefixedHexString
  ) {
    this.time = time
    this.from = from
    this.to = to
    this.data = data
    this.relayHubAddress = relayHubAddress
    this.relayWorker = relayWorker
    this.enabledQos = enabledQos === 'true' ? 'true' : 'false'
    this.signature = signature
  }

  public static TypeEncoding = 'commit(uint,address,address,bytes,address,address,bool)'

  orderForEnc (): any[] {
    return [
      this.time,
      this.from,
      this.to,
      this.data,
      this.relayHubAddress,
      this.relayWorker,
      this.enabledQos
    ]
  }

  encodeForSign (relayHubAddress: Address): PrefixedHexString {
    return ethers.utils.defaultAbiCoder.encode([Commitment.TypeEncoding, 'address'], [this.orderForEnc(), relayHubAddress])
  }
}