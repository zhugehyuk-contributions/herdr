# Not from orca. ⚠️ UNVERIFIED: no release build has been run.
#
# sshj resolves key/cipher/MAC factories through java.util.ServiceLoader and reflection over
# BouncyCastle class names, so R8 removes exactly the classes the handshake needs and the failure
# surfaces as "no matching key exchange algorithm" on release builds only.
-keep class net.schmizz.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn net.schmizz.sshj.**
-dontwarn org.slf4j.**
