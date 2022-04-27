/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { BigNumber, ContractTransaction } from "ethers"
import { BytesLike } from "@ethersproject/bytes"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type { IWalletRegistry, Bridge, BridgeStub } from "../../typechain"
import {
  walletPublicKey,
  walletPublicKeyHash,
  nonWitnessSignSingleInputTx,
  nonWitnessSignMultipleInputsTx,
  witnessSignSingleInputTx,
  witnessSignMultipleInputTx,
  wrongSighashType,
} from "../data/fraud"
import { constants, walletState } from "../fixtures"
import bridgeFixture from "./bridge-fixture"
import { ecdsaWalletTestData } from "../data/ecdsa"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const fixture = async () => bridgeFixture()

describe("Bridge - Fraud", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress

  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub

  let fraudChallengeDefeatTimeout: BigNumber
  let fraudChallengeDepositAmount: BigNumber

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, treasury, walletRegistry, bridge } =
      await waffle.loadFixture(fixture))
    ;({ fraudChallengeDefeatTimeout, fraudChallengeDepositAmount } =
      await bridge.fraudParameters())
  })

  describe("updateFraudParameters", () => {
    context("when caller is the contract guvnor", () => {
      context("when all new parameter values are correct", () => {
        const newFraudSlashingAmount = constants.fraudSlashingAmount.mul(2)
        const newFraudNotifierRewardMultiplier =
          constants.fraudNotifierRewardMultiplier / 4
        const newFraudChallengeDefeatTimeout =
          constants.fraudChallengeDefeatTimeout * 3
        const newFraudChallengeDepositAmount =
          constants.fraudChallengeDepositAmount.mul(4)

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await bridge
            .connect(governance)
            .updateFraudParameters(
              newFraudSlashingAmount,
              newFraudNotifierRewardMultiplier,
              newFraudChallengeDefeatTimeout,
              newFraudChallengeDepositAmount
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set correct values", async () => {
          const params = await bridge.fraudParameters()

          expect(params.fraudSlashingAmount).to.be.equal(newFraudSlashingAmount)
          expect(params.fraudNotifierRewardMultiplier).to.be.equal(
            newFraudNotifierRewardMultiplier
          )
          expect(params.fraudChallengeDefeatTimeout).to.be.equal(
            newFraudChallengeDefeatTimeout
          )
          expect(params.fraudChallengeDepositAmount).to.be.equal(
            newFraudChallengeDepositAmount
          )
        })

        it("should emit FraudParametersUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "FraudParametersUpdated")
            .withArgs(
              newFraudSlashingAmount,
              newFraudNotifierRewardMultiplier,
              newFraudChallengeDefeatTimeout,
              newFraudChallengeDepositAmount
            )
        })
      })

      context(
        "when new fraud notifier reward multiplier is greater than 100",
        () => {
          it("should revert", async () => {
            await expect(
              bridge
                .connect(governance)
                .updateFraudParameters(
                  constants.fraudSlashingAmount,
                  101,
                  constants.fraudChallengeDefeatTimeout,
                  constants.fraudChallengeDepositAmount
                )
            ).to.be.revertedWith(
              "Fraud notifier reward multiplier must be in the range [0, 100]"
            )
          })
        }
      )

      context("when new fraud challenge defeat timeout is zero", () => {
        it("should revert", async () => {
          await expect(
            bridge
              .connect(governance)
              .updateFraudParameters(
                constants.fraudSlashingAmount,
                constants.fraudNotifierRewardMultiplier,
                0,
                constants.fraudChallengeDepositAmount
              )
          ).to.be.revertedWith(
            "Fraud challenge defeat timeout must be greater than zero"
          )
        })
      })
    })

    context("when caller is not the contract guvnor", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .updateFraudParameters(
              constants.fraudSlashingAmount,
              constants.fraudNotifierRewardMultiplier,
              constants.fraudChallengeDefeatTimeout,
              constants.fraudChallengeDepositAmount
            )
        ).to.be.revertedWith("Caller is not the governance")
      })
    })
  })

  describe("submitFraudChallenge", () => {
    const data = witnessSignSingleInputTx

    context("when the wallet is in Live state", () => {
      context("when the amount of ETH deposited is enough", () => {
        context(
          "when the data needed for signature verification is correct",
          () => {
            context("when the fraud challenge does not exist yet", () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                await bridge.setWallet(walletPublicKeyHash, {
                  ecdsaWalletID: ethers.constants.HashZero,
                  mainUtxoHash: ethers.constants.HashZero,
                  pendingRedemptionsValue: 0,
                  createdAt: await lastBlockTime(),
                  movingFundsRequestedAt: 0,
                  closingStartedAt: 0,
                  state: walletState.Live,
                  movingFundsTargetWalletsCommitmentHash:
                    ethers.constants.HashZero,
                })

                tx = await bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.sighash,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should transfer ether from the caller to the bridge", async () => {
                await expect(tx).to.changeEtherBalance(
                  thirdParty,
                  fraudChallengeDepositAmount.mul(-1)
                )
                await expect(tx).to.changeEtherBalance(
                  bridge,
                  fraudChallengeDepositAmount
                )
              })

              it("should store the fraud challenge data", async () => {
                const challengeKey = buildChallengeKey(
                  walletPublicKey,
                  data.sighash
                )

                const fraudChallenge = await bridge.fraudChallenges(
                  challengeKey
                )

                expect(fraudChallenge.challenger).to.equal(
                  await thirdParty.getAddress()
                )
                expect(fraudChallenge.depositAmount).to.equal(
                  fraudChallengeDepositAmount
                )
                expect(fraudChallenge.reportedAt).to.equal(
                  await lastBlockTime()
                )
                expect(fraudChallenge.resolved).to.equal(false)
              })

              it("should emit FraudChallengeSubmitted event", async () => {
                await expect(tx)
                  .to.emit(bridge, "FraudChallengeSubmitted")
                  .withArgs(
                    walletPublicKeyHash,
                    data.sighash,
                    data.signature.v,
                    data.signature.r,
                    data.signature.s
                  )
              })
            })

            context("when the fraud challenge already exists", () => {
              before(async () => {
                await createSnapshot()

                await bridge.setWallet(walletPublicKeyHash, {
                  ecdsaWalletID: ethers.constants.HashZero,
                  mainUtxoHash: ethers.constants.HashZero,
                  pendingRedemptionsValue: 0,
                  createdAt: await lastBlockTime(),
                  movingFundsRequestedAt: 0,
                  closingStartedAt: 0,
                  state: walletState.Live,
                  movingFundsTargetWalletsCommitmentHash:
                    ethers.constants.HashZero,
                })

                await bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.sighash,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  bridge
                    .connect(thirdParty)
                    .submitFraudChallenge(
                      walletPublicKey,
                      data.sighash,
                      data.signature,
                      {
                        value: fraudChallengeDepositAmount,
                      }
                    )
                ).to.be.revertedWith("Fraud challenge already exists")
              })
            })
          }
        )

        context("when incorrect wallet public key is used", () => {
          // Unrelated Bitcoin public key
          const incorrectWalletPublicKey =
            "0xffc045ade19f8a5d464299146ce069049cdcc2390a9b44d9abcd83f11d8cce4" +
            "01ea6800e307b87aadebdcd2f7293cc60f0526afaff1a7b1abddfd787e6c5871e"

          const incorrectWalletPublicKeyHash =
            "0xb5222794425b9b8cd8c3358e73a50dea73480927"

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(incorrectWalletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  incorrectWalletPublicKey,
                  data.sighash,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect sighash is used", () => {
          // Random hex-string
          const incorrectSighash =
            "0x9e8e249791a5636e5e007fc15487b5a5bd6e60f73f7e236a7025cd63b904650b"

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  incorrectSighash,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect recovery ID is used", () => {
          // Increase the value of v by 1
          const incorrectV = data.signature.v + 1

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.connect(thirdParty).submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                {
                  r: data.signature.r,
                  s: data.signature.s,
                  v: incorrectV,
                },
                {
                  value: fraudChallengeDepositAmount,
                }
              )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect signature data is used", () => {
          // Swap r and s
          const incorrectS = data.signature.r
          const incorrectR = data.signature.s

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.connect(thirdParty).submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                {
                  r: incorrectR,
                  s: incorrectS,
                  v: data.signature.v,
                },
                {
                  value: fraudChallengeDepositAmount,
                }
              )
            ).to.be.revertedWith("Signature verification failure")
          })
        })
      })

      context("when the amount of ETH deposited is too low", () => {
        before(async () => {
          await createSnapshot()
          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                data.signature,
                {
                  value: fraudChallengeDepositAmount.sub(1),
                }
              )
          ).to.be.revertedWith("The amount of ETH deposited is too low")
        })
      })
    })

    context("when the wallet is in MovingFunds state", () => {
      before(async () => {
        await createSnapshot()
        await bridge.setWallet(walletPublicKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          state: walletState.MovingFunds,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.sighash,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )
        ).to.not.be.reverted
      })
    })

    context("when the wallet is in Closing state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(walletPublicKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          state: walletState.Closing,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.sighash,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )
        ).to.not.be.reverted
      })
    })

    context(
      "when the wallet is in neither Live nor MovingFunds nor Closing state",
      () => {
        const testData = [
          {
            testName: "when wallet state is Unknown",
            walletState: walletState.Unknown,
          },
          {
            testName: "when wallet state is Closed",
            walletState: walletState.Closed,
          },
          {
            testName: "when wallet state is Terminated",
            walletState: walletState.Terminated,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()
              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                state: test.walletState,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.sighash,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              ).to.be.revertedWith(
                "Wallet must be in Live or MovingFunds or Closing state"
              )
            })
          })
        })
      }
    )
  })

  describe("defeatFraudChallenge", () => {
    context("when the challenge exists", () => {
      context("when the challenge is open", () => {
        context("when the sighash type is correct", () => {
          context("when the input is non-witness", () => {
            context("when the transaction has single input", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignSingleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignSingleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })

            context("when the transaction has multiple inputs", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignMultipleInputsTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignMultipleInputsTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })
          })

          context("when the input is witness", () => {
            context("when the transaction has single input", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignSingleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignSingleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })

            context("when the transaction has multiple inputs", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignMultipleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignMultipleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })
          })
        })

        context("when the sighash type is incorrect", () => {
          // Wrong sighash was used (SIGHASH_NONE | SIGHASH_ANYONECANPAY) during
          // input signing
          const data = wrongSighashType

          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            ).to.be.revertedWith("Wrong sighash type")
          })
        })
      })

      context("when the challenge is resolved by defeat", () => {
        const data = nonWitnessSignSingleInputTx

        before(async () => {
          await createSnapshot()

          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
          await bridge.setSweptDeposits(data.deposits)
          await bridge.setSpentMainUtxos(data.spentMainUtxos)

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.sighash,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await bridge
            .connect(thirdParty)
            .defeatFraudChallenge(walletPublicKey, data.preimage, false)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })

      context("when the challenge is resolved by timeout", () => {
        const data = nonWitnessSignSingleInputTx

        before(async () => {
          await createSnapshot()

          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
          await bridge.setSweptDeposits(data.deposits)
          await bridge.setSpentMainUtxos(data.spentMainUtxos)

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.sighash,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await increaseTime(fraudChallengeDefeatTimeout)

          await bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(walletPublicKey, data.sighash)
        })

        after(async () => {
          walletRegistry.closeWallet.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })
    })

    context("when the challenge does not exist", () => {
      const data = nonWitnessSignMultipleInputsTx

      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .defeatFraudChallenge(walletPublicKey, data.preimage, false)
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  describe("notifyFraudChallengeDefeatTimeout", () => {
    const data = nonWitnessSignSingleInputTx

    context("when the fraud challenge exists", () => {
      context("when the fraud challenge is open", () => {
        context("when the fraud challenge has timed out", () => {
          const walletDraft = {
            ecdsaWalletID: ecdsaWalletTestData.walletID,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: 0,
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            state: walletState.Unknown,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          }

          context(
            "when the wallet is in the Live or MovingFunds or Closing state",
            () => {
              const testData: {
                testName: string
                walletState: number
                additionalSetup?: () => Promise<void>
                additionalAssertions?: (args?: any) => Promise<void>
              }[] = [
                {
                  testName:
                    "when wallet state is Live but the wallet is not the active one",
                  walletState: walletState.Live,
                  additionalSetup: async () => {
                    // The active wallet is a different wallet than the active one
                    await bridge.setActiveWallet(
                      "0x0b9f85c224b0e018a5865392927b3f9e16cf5e79"
                    )
                  },
                  additionalAssertions: async (args: any) => {
                    it("should decrease the live wallets count", async () => {
                      expect(await bridge.liveWalletsCount()).to.be.equal(0)
                    })

                    it("should not unset the active wallet", async () => {
                      expect(
                        await bridge.activeWalletPubKeyHash()
                      ).to.be.not.equal(
                        "0x0000000000000000000000000000000000000000"
                      )
                    })
                  },
                },
                {
                  testName:
                    "when wallet state is Live and the wallet is the active one",
                  walletState: walletState.Live,
                  additionalSetup: async () => {
                    await bridge.setActiveWallet(walletPublicKeyHash)
                  },
                  additionalAssertions: async (args: any) => {
                    it("should decrease the live wallets count", async () => {
                      expect(await bridge.liveWalletsCount()).to.be.equal(0)
                    })

                    it("should unset the active wallet", async () => {
                      expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                        "0x0000000000000000000000000000000000000000"
                      )
                    })
                  },
                },
                {
                  testName: "when wallet state is MovingFunds",
                  walletState: walletState.MovingFunds,
                  additionalSetup: async () => {},
                  additionalAssertions: async () => {},
                },
                {
                  testName: "when wallet state is Closing",
                  walletState: walletState.Closing,
                  additionalSetup: async () => {},
                  additionalAssertions: async () => {},
                },
              ]

              testData.forEach((test) => {
                context(test.testName, async () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: test.walletState,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    await increaseTime(fraudChallengeDefeatTimeout)

                    await test.additionalSetup()

                    tx = await bridge
                      .connect(thirdParty)
                      .notifyFraudChallengeDefeatTimeout(
                        walletPublicKey,
                        data.sighash
                      )
                  })

                  after(async () => {
                    walletRegistry.closeWallet.reset()

                    await restoreSnapshot()
                  })

                  it("should mark the fraud challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.be.true
                  })

                  it("should return the deposited ether to the challenger", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      thirdParty,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeatTimedOut event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeatTimedOut")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })

                  it("should change the wallet state to Terminated", async () => {
                    expect(
                      (await bridge.wallets(walletPublicKeyHash)).state
                    ).to.be.equal(walletState.Terminated)
                  })

                  it("should emit WalletTerminated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "WalletTerminated")
                      .withArgs(walletDraft.ecdsaWalletID, walletPublicKeyHash)
                  })

                  it("should call the ECDSA wallet registry's closeWallet function", async () => {
                    expect(
                      walletRegistry.closeWallet
                    ).to.have.been.calledOnceWith(walletDraft.ecdsaWalletID)
                  })

                  await test.additionalAssertions()
                })
              })
            }
          )

          context("when the wallet is in the Terminated state", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // First, the wallet must be Live to make fraud challenge
              // submission possible.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Live,
              })

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.sighash,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              await increaseTime(fraudChallengeDefeatTimeout)

              // Then, the state of the wallet changes to the Terminated
              // state.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Terminated,
              })

              tx = await bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  data.sighash
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should mark the fraud challenge as resolved", async () => {
              const challengeKey = buildChallengeKey(
                walletPublicKey,
                data.sighash
              )

              const fraudChallenge = await bridge.fraudChallenges(challengeKey)

              expect(fraudChallenge.resolved).to.be.true
            })

            it("should return the deposited ether to the challenger", async () => {
              await expect(tx).to.changeEtherBalance(
                bridge,
                fraudChallengeDepositAmount.mul(-1)
              )
              await expect(tx).to.changeEtherBalance(
                thirdParty,
                fraudChallengeDepositAmount
              )
            })

            it("should emit FraudChallengeDefeatTimedOut event", async () => {
              await expect(tx)
                .to.emit(bridge, "FraudChallengeDefeatTimedOut")
                .withArgs(walletPublicKeyHash, data.sighash)
            })

            it("should not change the wallet state", async () => {
              expect(
                (await bridge.wallets(walletPublicKeyHash)).state
              ).to.be.equal(walletState.Terminated)
            })
          })

          context(
            "when the wallet is neither in the Live nor MovingFunds nor Closing nor Terminated state",
            () => {
              const testData = [
                {
                  testName: "when the wallet is in the Unknown state",
                  walletState: walletState.Unknown,
                },
                {
                  testName: "when the wallet is in the Closed state",
                  walletState: walletState.Closed,
                },
              ]

              testData.forEach((test) => {
                context(test.testName, () => {
                  before(async () => {
                    await createSnapshot()

                    // First, the wallet must be Live to make fraud challenge
                    // submission possible.
                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: walletState.Live,
                    })

                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.sighash,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    await increaseTime(fraudChallengeDefeatTimeout)

                    // Then, the state of the wallet changes to the tested
                    // state.
                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: test.walletState,
                    })
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .notifyFraudChallengeDefeatTimeout(
                          walletPublicKey,
                          data.sighash
                        )
                    ).to.be.revertedWith(
                      "Wallet must be in Live or MovingFunds or Closing or Terminated state"
                    )
                  })
                })
              })
            }
          )
        })

        context("when the fraud challenge has not timed out yet", () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await increaseTime(fraudChallengeDefeatTimeout.sub(2))
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  data.sighash
                )
            ).to.be.revertedWith(
              "Fraud challenge defeat period did not time out yet"
            )
          })
        })
      })

      context(
        "when the fraud challenge is resolved by challenge defeat",
        () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  data.sighash
                )
            ).to.be.revertedWith("Fraud challenge has already been resolved")
          })
        }
      )

      context(
        "when the fraud challenge is resolved by previous timeout notification",
        () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.sighash,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await increaseTime(fraudChallengeDefeatTimeout)

            await bridge
              .connect(thirdParty)
              .notifyFraudChallengeDefeatTimeout(walletPublicKey, data.sighash)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  data.sighash
                )
            ).to.be.revertedWith("Fraud challenge has already been resolved")
          })
        }
      )
    })

    context("when the fraud challenge does not exist", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(walletPublicKey, data.sighash)
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  function buildChallengeKey(publicKey: BytesLike, sighash: BytesLike): string {
    return ethers.utils.solidityKeccak256(
      ["bytes", "bytes32"],
      [publicKey, sighash]
    )
  }
})
