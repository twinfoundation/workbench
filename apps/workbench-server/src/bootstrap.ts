// Copyright 2024 IOTA Stiftung.
// SPDX-License-Identifier: Apache-2.0.
import { PasswordHelper, type AuthenticationUser } from "@twin.org/api-auth-entity-storage-service";
import { CLIDisplay } from "@twin.org/cli-core";
import {
	Coerce,
	Converter,
	GeneralError,
	I18n,
	Is,
	RandomHelper,
	StringHelper
} from "@twin.org/core";
import { Bip39, PasswordGenerator } from "@twin.org/crypto";
import {
	EntityStorageConnectorFactory,
	type IEntityStorageConnector
} from "@twin.org/entity-storage-models";
import { IotaIdentityUtils } from "@twin.org/identity-connector-iota";
import {
	IdentityConnectorFactory,
	IdentityProfileConnectorFactory
} from "@twin.org/identity-models";
import { nameof } from "@twin.org/nameof";
import { VaultConnectorFactory, VaultKeyType } from "@twin.org/vault-models";
import type { WalletAddress } from "@twin.org/wallet-connector-entity-storage";
import { WalletConnectorFactory } from "@twin.org/wallet-models";
import type { Person, WithContext } from "schema-dts";
import { ATTESTATION_ASSERTION_METHOD_ID } from "./components/attestation.js";
import { BLOB_ENCRYPTION_KEY } from "./components/blobStorage.js";
import {
	IMMUTABLE_PROOF_ASSERTION_METHOD_ID,
	IMMUTABLE_PROOF_ENCRYPTION_KEY
} from "./components/immutableProof.js";
import { nodeLogInfo } from "./components/logging.js";
import { AUTH_SIGNING_NAME_VAULT_KEY } from "./components/processors.js";
import { writeConfig } from "./configure.js";
import type { IWorkbenchContext } from "./models/IWorkbenchContext.js";

export const DEFAULT_NODE_ADMIN_EMAIL = "admin@node";

/**
 * Bootstrap the application.
 * @param context The context for the node.
 */
export async function bootstrap(context: IWorkbenchContext): Promise<void> {
	try {
		for (const instance of context.componentInstances) {
			if (Is.function(instance.component.bootstrap)) {
				const bootstrapName = `${instance.component.CLASS_NAME}-${instance.instanceName}`;

				if (!context.config.bootstrappedComponents.includes(bootstrapName)) {
					displayBootstrapStarted(context);
					nodeLogInfo(
						I18n.formatMessage("workbench.bootstrapping", {
							element: bootstrapName
						})
					);
					const result = await instance.component.bootstrap(context.nodeLoggingConnectorName);
					if (!result) {
						throw new GeneralError("Workbench", "bootstrapFailed");
					}
					context.config.bootstrappedComponents.push(bootstrapName);
					context.configUpdated = true;
				}
			}
		}

		await bootstrapNodeIdentity(context);
		await bootstrapNodeUser(context);
		await bootstrapAuth(context);
		await bootstrapBlobEncryption(context);
		await bootstrapImmutableProofEncryption(context);
		await bootstrapAttestationMethod(context);
		await bootstrapImmutableProofMethod(context);
	} finally {
		if (context.configUpdated) {
			await writeConfig(context.storageFileRoot, context.workbenchConfigFilename, context.config);
			context.configUpdated = false;
			CLIDisplay.task(I18n.formatMessage("workbench.bootstrapComplete"));
			CLIDisplay.break();
		}
	}
}

/**
 * Display that the bootstrap has started.
 * @param context The context for the node.
 */
function displayBootstrapStarted(context: IWorkbenchContext): void {
	if (!context.configUpdated) {
		CLIDisplay.break();
		CLIDisplay.task(I18n.formatMessage("workbench.bootstrapStarted"));
		CLIDisplay.break();
	}
}

/**
 * Bootstrap the node creating any necessary resources.
 * @param context The context for the node.
 */
export async function bootstrapNodeIdentity(context: IWorkbenchContext): Promise<void> {
	// If there is no identity set in the node config then we need
	// to setup the identity for the node
	if (!Is.stringValue(context.config.nodeIdentity)) {
		displayBootstrapStarted(context);

		// When we bootstrap the node we need to generate an identity for it,
		// But we have a chicken and egg problem in that we can't create the identity
		// to store the mnemonic in the vault without an identity. We use a temporary identity
		// and then replace it with the new identity later in the process.
		const nodeIdentity = `bootstrap-${Converter.bytesToBase64(RandomHelper.generate(32))}`;

		// Create a secure mnemonic and store it in the vault so that wallet operations
		// can be performed
		const mnemonic = Bip39.randomMnemonic();
		nodeLogInfo(I18n.formatMessage("workbench.generatingMnemonic", { mnemonic }));

		const vaultConnector = VaultConnectorFactory.get(context.envVars.WORKBENCH_VAULT_CONNECTOR);
		await vaultConnector.setSecret(`${nodeIdentity}/mnemonic`, mnemonic);

		// Generate an address from the wallet, this will use the mnemonic from above
		const walletConnector = WalletConnectorFactory.get(context.envVars.WORKBENCH_WALLET_CONNECTOR);
		const addresses = await walletConnector.getAddresses(nodeIdentity, 0, 0, 5);

		let address0 = addresses[0];

		if (context.envVars.WORKBENCH_WALLET_CONNECTOR === "iota") {
			address0 = `${context.envVars.WORKBENCH_IOTA_EXPLORER_URL}addr/${address0}`;
		}

		nodeLogInfo(I18n.formatMessage("workbench.fundingWallet", { address: address0 }));

		// Add some funds to the wallet from the faucet
		await walletConnector.ensureBalance(nodeIdentity, addresses[0], 1000000000n);

		nodeLogInfo(I18n.formatMessage("workbench.generatingNodeIdentity"));

		// Now create an identity for the node controlled by the address we just funded
		const identityConnector = IdentityConnectorFactory.get(
			context.envVars.WORKBENCH_IDENTITY_CONNECTOR
		);
		const identityDocument = await identityConnector.createDocument(nodeIdentity);

		if (context.envVars.WORKBENCH_IDENTITY_CONNECTOR === "iota") {
			nodeLogInfo(
				I18n.formatMessage("workbench.identityExplorer", {
					url: `${process.env.WORKBENCH_IOTA_EXPLORER_URL}addr/${IotaIdentityUtils.didToAddress(identityDocument.id)}?tab=DID`
				})
			);
		}

		// If we are using entity storage for wallet the identity associated with the
		// address will be wrong, so fix it
		if (context.envVars.WORKBENCH_WALLET_CONNECTOR === "entity-storage") {
			const walletAddress = EntityStorageConnectorFactory.get<
				IEntityStorageConnector<WalletAddress>
			>(StringHelper.kebabCase(nameof<WalletAddress>()));
			const addr = await walletAddress.get(addresses[0]);
			if (!Is.empty(addr)) {
				addr.identity = identityDocument.id;
				await walletAddress.set(addr);
			}
		}

		context.config.nodeIdentity = identityDocument.id;
		context.config.addresses = addresses;
		context.configUpdated = true;

		// Now that we have an identity we can remove the temporary one
		// and store the mnemonic with the new identity
		await vaultConnector.removeSecret(`${nodeIdentity}/mnemonic`);

		await vaultConnector.setSecret(`${identityDocument.id}/mnemonic`, mnemonic);

		nodeLogInfo(
			I18n.formatMessage("workbench.nodeIdentity", {
				identity: context.config.nodeIdentity
			})
		);
	}
}

/**
 * Bootstrap the user.
 * @param context The context for the node.
 */
export async function bootstrapNodeUser(context: IWorkbenchContext): Promise<void> {
	if (
		context.envVars.WORKBENCH_AUTH_PROCESSOR_TYPE === "entity-storage" &&
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("LoginUser")
	) {
		displayBootstrapStarted(context);

		// Create the login for the node user
		const authUserEntityStorage = EntityStorageConnectorFactory.get<
			IEntityStorageConnector<AuthenticationUser>
		>(StringHelper.kebabCase(nameof<AuthenticationUser>()));

		const generatedPassword = PasswordGenerator.generate(16);
		const passwordBytes = Converter.utf8ToBytes(generatedPassword);
		const saltBytes = RandomHelper.generate(16);

		const hashedPassword = await PasswordHelper.hashPassword(passwordBytes, saltBytes);

		const nodeAdminUser: AuthenticationUser = {
			email: DEFAULT_NODE_ADMIN_EMAIL,
			password: hashedPassword,
			salt: Converter.bytesToBase64(saltBytes),
			identity: context.config.nodeIdentity
		};

		nodeLogInfo(I18n.formatMessage("workbench.nodeAdminUserEmail", { email: nodeAdminUser.email }));
		nodeLogInfo(
			I18n.formatMessage("workbench.nodeAdminUserPassword", { password: generatedPassword })
		);

		await authUserEntityStorage.set(nodeAdminUser);

		// We have create a node user, now we need to create a profile for the user
		const identityProfileConnector = IdentityProfileConnectorFactory.get(
			context.envVars.WORKBENCH_IDENTITY_PROFILE_CONNECTOR
		);

		if (identityProfileConnector) {
			const publicProfile: WithContext<Person> = {
				"@context": "https://schema.org",
				"@type": "Person",
				name: "Node Administrator"
			};
			const privateProfile: WithContext<Person> = {
				"@context": "https://schema.org",
				"@type": "Person",
				givenName: "Node",
				familyName: "Administrator",
				email: nodeAdminUser.email
			};
			await identityProfileConnector.create(
				context.config.nodeIdentity,
				publicProfile,
				privateProfile
			);
		}
		context.config.bootstrappedComponents.push("LoginUser");
		context.configUpdated = true;
	}
}

/**
 * Bootstrap the attestation verification methods.
 * @param context The context for the node.
 */
export async function bootstrapAttestationMethod(context: IWorkbenchContext): Promise<void> {
	if (
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("AttestationMethod")
	) {
		displayBootstrapStarted(context);

		const identityConnector = IdentityConnectorFactory.get(
			context.envVars.WORKBENCH_IDENTITY_CONNECTOR
		);

		// Add attestation verification method to DID, the correct node context is now in place
		// so the keys for the verification method will be stored correctly
		nodeLogInfo(I18n.formatMessage("workbench.addingAttestation"));
		await identityConnector.addVerificationMethod(
			context.config.nodeIdentity,
			context.config.nodeIdentity,
			"assertionMethod",
			ATTESTATION_ASSERTION_METHOD_ID
		);

		context.config.bootstrappedComponents.push("AttestationMethod");
		context.configUpdated = true;
	}
}

/**
 * Bootstrap the immutable proof verification methods.
 * @param context The context for the node.
 */
export async function bootstrapImmutableProofMethod(context: IWorkbenchContext): Promise<void> {
	if (
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("ImmutableProofMethod")
	) {
		displayBootstrapStarted(context);

		const identityConnector = IdentityConnectorFactory.get(
			context.envVars.WORKBENCH_IDENTITY_CONNECTOR
		);

		// Add AIG verification method to DID, the correct node context is now in place
		// so the keys for the verification method will be stored correctly
		nodeLogInfo(I18n.formatMessage("workbench.addingImmutableProof"));
		await identityConnector.addVerificationMethod(
			context.config.nodeIdentity,
			context.config.nodeIdentity,
			"assertionMethod",
			IMMUTABLE_PROOF_ASSERTION_METHOD_ID
		);

		context.config.bootstrappedComponents.push("ImmutableProofMethod");
		context.configUpdated = true;
	}
}

/**
 * Bootstrap the keys for blob encryption.
 * @param context The context for the node.
 */
export async function bootstrapBlobEncryption(context: IWorkbenchContext): Promise<void> {
	const enableBlobEncryption =
		Coerce.boolean(context.envVars.WORKBENCH_BLOB_STORAGE_ENABLE_ENCRYPTION) ?? false;
	if (
		enableBlobEncryption &&
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("BlobEncryption")
	) {
		displayBootstrapStarted(context);

		// Create a new key for encrypting blobs
		const vaultConnector = VaultConnectorFactory.get(context.envVars.WORKBENCH_VAULT_CONNECTOR);

		await vaultConnector.createKey(
			`${context.config.nodeIdentity}/${BLOB_ENCRYPTION_KEY}`,
			VaultKeyType.Ed25519
		);

		context.config.bootstrappedComponents.push("BlobEncryption");
		context.configUpdated = true;
	}
}

/**
 * Bootstrap the keys for immutable proof encryption.
 * @param context The context for the node.
 */
export async function bootstrapImmutableProofEncryption(context: IWorkbenchContext): Promise<void> {
	if (
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("ImmutableProof")
	) {
		displayBootstrapStarted(context);

		// Create a new key for encrypting auditable item graph data
		const vaultConnector = VaultConnectorFactory.get(context.envVars.WORKBENCH_VAULT_CONNECTOR);

		await vaultConnector.createKey(
			`${context.config.nodeIdentity}/${IMMUTABLE_PROOF_ENCRYPTION_KEY}`,
			VaultKeyType.Ed25519
		);

		context.config.bootstrappedComponents.push("ImmutableProof");
		context.configUpdated = true;
	}
}

/**
 * Bootstrap the JWT signing key.
 * @param context The context for the node.
 */
export async function bootstrapAuth(context: IWorkbenchContext): Promise<void> {
	if (
		context.envVars.WORKBENCH_AUTH_PROCESSOR_TYPE === "entity-storage" &&
		Is.stringValue(context.config.nodeIdentity) &&
		!context.config.bootstrappedComponents.includes("JwtKey")
	) {
		displayBootstrapStarted(context);

		// Create a new JWT signing key and a user login for the node
		const vaultConnector = VaultConnectorFactory.get(context.envVars.WORKBENCH_VAULT_CONNECTOR);
		await vaultConnector.createKey(
			`${context.config.nodeIdentity}/${AUTH_SIGNING_NAME_VAULT_KEY}`,
			VaultKeyType.Ed25519
		);

		context.config.bootstrappedComponents.push("JwtKey");
		context.configUpdated = true;
	}
}
