import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { deployer, governance } = await getNamedAccounts()

  const BridgeGovernance = await deployments.get("BridgeGovernance")

  await deployments.execute(
    "Bridge",
    { from: deployer },
    "transferGovernance",
    BridgeGovernance.address
  )
}

export default func

func.tags = ["TransferGovernance"]
func.dependencies = ["Bridge"]
func.runAtTheEnd = true
