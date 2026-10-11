// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "InterviewsCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "InterviewsCore", targets: ["InterviewsCore"]),
    ],
    targets: [
        .target(name: "InterviewsCore"),
        .testTarget(name: "InterviewsCoreTests", dependencies: ["InterviewsCore"]),
    ]
)
